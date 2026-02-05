import { IRDocument, Node, FunctionDef, Edge, RenderPipelineDef, BuiltinOp } from '../ir/types';
import { OpDefs } from '../ir/builtin-schemas';
import { EvaluationContext, RuntimeValue } from './context';
import { OpRegistry } from './ops';
import { SoftwareRasterizer } from './rasterizer';
import { reconstructEdges } from '../ir/utils';

export class InterpretedExecutor {
  context: EvaluationContext;
  private rasterizer?: SoftwareRasterizer;

  constructor(context: EvaluationContext) {
    this.context = context;
  }

  executeEntry() {
    this.context.pushFrame('entry');
    const entryFunc = this.context.ir.functions.find(f => f.id === this.context.ir.entryPoint);
    if (!entryFunc) throw new Error('Entry point not found');
    this.context.result = this.executeFunction(entryFunc) ?? undefined;
    this.context.popFrame();
  }

  executeFunction(func: FunctionDef): RuntimeValue | void {
    const edges = reconstructEdges(func);

    // 1. Initialize Locals
    for (const v of func.localVars) {
      if (v.initialValue !== undefined) {
        this.context.setVar(v.id, v.initialValue);
      } else {
        this.context.setVar(v.id, this.constructDefaultValue(v.type));
      }
    }

    // 2. Find entry nodes
    const entryNodes = func.nodes.filter(n => {
      const hasExecIn = edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutableNode(n);
    });

    const executionQueue: Node[] = [...entryNodes];

    // BFS / Flow Execution
    while (executionQueue.length > 0) {
      const node = executionQueue.shift()!;

      const result = this.executeNode(node, func, edges);

      if (node.op === 'func_return') {
        return result;
      }

      if (node.op === 'flow_branch') {
        this.handleBranch(node, func, executionQueue, edges);
      } else if (node.op === 'flow_loop') {
        this.handleLoop(node, func, executionQueue, edges);
      } else {
        this.continueFlow(node, 'exec_out', func, executionQueue, edges);
      }
    }
  }

  private isExecutableNode(node: Node): boolean {
    return node.op.startsWith('cmd_') ||
      node.op.startsWith('flow_') ||
      node.op.startsWith('var_set') ||
      node.op.startsWith('array_set') ||
      node.op.startsWith('buffer_store') ||
      node.op.startsWith('texture_store') ||
      node.op === 'call_func' ||
      node.op === 'func_return';
  }

  protected executeNode(node: Node, func: FunctionDef, edges: Edge[]): RuntimeValue | void {
    const opId = node.op;

    if (opId === 'flow_branch' || opId === 'flow_loop') return;

    if (opId === 'cmd_dispatch') {
      const nodeProps: Record<string, RuntimeValue> = {};
      this.mixinNodeProperties(node, nodeProps, func, edges);

      const targetId = (nodeProps.func || nodeProps.target) as string;
      const dispatchArgs = { ...nodeProps, ...(nodeProps.args as any || {}) };
      const dimExpr = nodeProps.dispatch;

      const dim: [number, number, number] = [1, 1, 1];
      if (Array.isArray(dimExpr)) {
        const d = dimExpr as any[];
        dim[0] = Number(d[0]) || 1;
        dim[1] = Number(d[1]) || 1;
        dim[2] = Number(d[2]) || 1;
      } else if (typeof dimExpr === 'number') {
        dim[0] = dimExpr;
      }

      const targetFunc = this.context.ir.functions.find(f => f.id === targetId);
      if (targetFunc) {
        for (let z = 0; z < dim[2]; z++) {
          for (let y = 0; y < dim[1]; y++) {
            for (let x = 0; x < dim[0]; x++) {
              this.context.builtins.set('global_invocation_id', [x, y, z]);
              this.context.builtins.set('local_invocation_id', [x, y, z]);
              this.context.builtins.set('workgroup_id', [0, 0, 0]);
              this.context.builtins.set('local_invocation_index', 0);
              this.context.builtins.set('num_workgroups', dim);
              this.context.pushFrame(targetId);

              // Set arguments into the shader frame
              if (targetFunc.inputs) {
                for (const inputDef of targetFunc.inputs) {
                  const val = (dispatchArgs as any)[inputDef.id];
                  if (val !== undefined) {
                    if (typeof val === 'string') {
                      throw new Error(`Runtime Error: Cannot marshal string value "${val}" to shader non-string input '${inputDef.id}'`);
                    }
                    this.context.setVar(inputDef.id, val);
                  }
                }
              }

              this.executeFunction(targetFunc);
              this.context.popFrame();
            }
          }
        }
      }
      return;
    }

    if (opId === 'cmd_draw') {
      const args: Record<string, RuntimeValue> = {};
      this.mixinNodeProperties(node, args, func, edges);

      const targetId = args.target as string;
      const vertexId = args.vertex as string;
      const fragmentId = args.fragment as string;
      const count = args.count as number;
      const pipeline = args.pipeline as RenderPipelineDef;

      if (!this.rasterizer) {
        this.rasterizer = new SoftwareRasterizer(this.context);
      }

      this.rasterizer.draw(targetId, vertexId, fragmentId, count, pipeline);
      return;
    }

    if (opId === 'call_func') {
      const targetId = node.func as string;
      const targetFunc = this.context.ir.functions.find(f => f.id === targetId);
      if (!targetFunc) throw new Error(`Function '${targetId}' not found`);

      // RECURSION CHECK
      if (this.context.stack.some(frame => frame.name === targetId)) {
        throw new Error(`Runtime Error: Recursion detected for function '${targetId}'`);
      }

      const nodeProps: Record<string, RuntimeValue> = {};
      this.mixinNodeProperties(node, nodeProps, func, edges);
      const callArgs = { ...nodeProps, ...(nodeProps.args as any || {}) };

      this.context.pushFrame(targetId);

      if (targetFunc.inputs) {
        for (const inputDef of targetFunc.inputs) {
          const val = (callArgs as any)[inputDef.id];
          if (val !== undefined) {
            this.context.setVar(inputDef.id, val);
          }
        }
      }

      const result = this.executeFunction(targetFunc);
      this.context.popFrame();

      if (result !== undefined) {
        this.context.currentFrame.nodeResults.set(node.id, result);
      }
      return result;
    }

    // Standard Ops
    const handler = OpRegistry[opId as keyof typeof OpRegistry];
    if (handler) {
      const args: Record<string, RuntimeValue> = {};
      this.mixinNodeProperties(node, args, func, edges);
      const result = handler(this.context, args as any); // any cast is valid, since Zod has already validated these args match the op.
      if (result !== undefined) {
        this.context.currentFrame.nodeResults.set(node.id, result);
      }
      return result;
    } else {
      throw new Error(`Op not supported ${opId}`);
    }
  }

  private continueFlow(node: Node, port: string, func: FunctionDef, queue: Node[], edges: Edge[]) {
    const nextEdges = edges.filter(e => e.from === node.id && e.portOut === port && e.type === 'execution');
    for (const edge of nextEdges) {
      const nextNode = func.nodes.find(n => n.id === edge.to);
      if (nextNode) queue.push(nextNode);
    }
  }

  private handleBranch(node: Node, func: FunctionDef, queue: Node[], edges: Edge[]) {
    const args: any = {};
    this.mixinNodeProperties(node, args, func, edges);
    const condVal = !!args.cond;

    if (condVal) {
      this.continueFlow(node, 'exec_true', func, queue, edges);
    } else {
      this.continueFlow(node, 'exec_false', func, queue, edges);
    }
  }

  private handleLoop(node: Node, func: FunctionDef, queue: Node[], edges: Edge[]) {
    const args: any = {};
    this.mixinNodeProperties(node, args, func, edges);
    const start = args.start as number;
    const end = args.end as number;

    for (let i = start; i < end; i++) {
      this.context.setLoopIndex(node.id, i);
      // Clear node result cache to ensure nodes inside loop are re-evaluated
      this.context.currentFrame.nodeResults.clear();

      const bodyEdges = edges.filter(e => e.from === node.id && e.portOut === 'exec_body' && e.type === 'execution');
      for (const edge of bodyEdges) {
        const bodyNode = func.nodes.find(n => n.id === edge.to);
        if (bodyNode) {
          this.executeChain(bodyNode, func, edges);
        }
      }
    }

    this.continueFlow(node, 'exec_completed', func, queue, edges);
  }

  private executeChain(startNode: Node, func: FunctionDef, edges: Edge[]) {
    const q = [startNode];
    while (q.length) {
      const n = q.shift()!;
      this.executeNode(n, func, edges);

      if (n.op === 'func_return') {
        // Ignoring return in loop for now
      }

      if (n.op === 'flow_branch') {
        this.handleBranch(n, func, q, edges);
      } else if (n.op === 'flow_loop') {
        this.handleLoop(n, func, q, edges);
      } else {
        this.continueFlow(n, 'exec_out', func, q, edges);
      }
    }
  }

  protected resolveNodeValue(node: Node | string, func: FunctionDef, edges: Edge[]): RuntimeValue {
    if (typeof node === 'string') {
      const v = this.context.getVar(node);
      if (v !== undefined) return v;
      try { return this.context.getInput(node); } catch {
        // Not a var or input, try resolving as node ID
        const targetNode = func.nodes.find(n => n.id === node);
        if (targetNode) return this.resolveNodeValue(targetNode, func, edges);
        return 0;
      }
    }

    if (this.context.currentFrame.nodeResults.has(node.id)) {
      return this.context.currentFrame.nodeResults.get(node.id)!;
    }

    // Special Handling for Executable Nodes that return values (like call_func)
    if (this.isExecutableNode(node)) {
      const res = this.executeNode(node, func, edges);
      return (res !== undefined) ? res : 0;
    }

    const args: Record<string, RuntimeValue> = {};
    this.mixinNodeProperties(node, args, func, edges);

    const handler = OpRegistry[node.op as keyof typeof OpRegistry];
    if (handler) {
      const result = handler(this.context, args as any);
      if (result !== undefined && node.op !== 'loop_index') {
        this.context.currentFrame.nodeResults.set(node.id, result);
      }
      return result ?? 0;
    }
    return 0;
  }

  protected mixinNodeProperties(node: Node, args: Record<string, RuntimeValue>, func: FunctionDef, edges: Edge[]) {
    const def = OpDefs[node.op as BuiltinOp];
    const INTERNAL_KEYS = new Set(['id', 'op', 'metadata', 'comment', 'dataType', 'exec_in', 'exec_out', 'next', '_next']);
    const isNodeId = (id: string) => func.nodes.some(n => n.id === id);

    // 1. Literal properties and metadata references (var names, resource IDs, etc.)
    for (const [key, val] of Object.entries(node)) {
      if (INTERNAL_KEYS.has(key)) continue;

      const argDef = def?.args[key];
      if (argDef || def?.isDynamic) {
        args[key] = this.resolveLiteralValue(val, argDef?.refType || 'data', func);
      }
    }

    // 2. Resolve Incoming Data Flow (Pull values from dependencies)
    const incomingEdges = edges.filter(e => e.to === node.id && e.type === 'data');
    for (const edge of incomingEdges) {
      if (edge.from === node.id) continue; // Safety: skip self-references

      const sourceValue = this.resolveNodeValue(edge.from, func, edges);
      if (sourceValue !== undefined) {
        this.assignValueToPort(args, edge.portIn, sourceValue);
      }
    }
  }

  /**
   * Recursively resolve literal values, handling references inside dictionaries/arrays.
   */
  private resolveLiteralValue(val: any, refType: string, func: FunctionDef): any {
    const isNodeId = (id: string) => func.nodes.some(n => n.id === id);

    if (typeof val === 'string' && refType === 'data' && !isNodeId(val)) {
      const varVal = this.context.getVar(val);
      if (varVal !== undefined) return varVal;
      try { return this.context.getInput(val); } catch (e) { }
      return val;
    }

    if (Array.isArray(val)) {
      return val.map(v => this.resolveLiteralValue(v, refType, func));
    }

    if (val !== null && typeof val === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = this.resolveLiteralValue(v, refType, func);
      }
      return out;
    }

    return val;
  }

  /**
   * Helper to set value to a port, handling indexed or nested notation (e.g. "args.x", "values[0]")
   */
  private assignValueToPort(args: Record<string, any>, port: string, value: any) {
    if (port.includes('.') || port.includes('[')) {
      const parts = port.split(/[\.\[\]]/).filter(p => p !== '');
      let curr = args;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        const nextIsIndex = !isNaN(parseInt(parts[i + 1], 10));
        if (curr[p] === undefined) {
          curr[p] = nextIsIndex ? [] : {};
        }
        curr = curr[p];
      }
      const last = parts[parts.length - 1];
      const lastIdx = parseInt(last, 10);
      if (!isNaN(lastIdx)) {
        curr[lastIdx] = value;
      } else {
        curr[last] = value;
      }
      return;
    }

    // Default: direct property assignment
    args[port] = value;
  }

  private constructDefaultValue(type: string): RuntimeValue {
    if (type === 'float' || type === 'f32') return 0.0;
    if (type === 'int' || type === 'i32') return 0;
    if (type === 'bool') return false;
    if (type === 'string') return '';
    if (type === 'float2' || type === 'vec2<f32>') return [0, 0];
    if (type === 'float3' || type === 'vec3<f32>') return [0, 0, 0];
    if (type === 'float4' || type === 'vec4<f32>') return [0, 0, 0, 0];
    if (type === 'float3x3' || type === 'mat3x3<f32>') return [0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (type === 'float4x4' || type === 'mat4x4<f32>') return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    // Array
    if (type.startsWith('array<')) {
      return [];
    }

    // Structs?
    // In strict mode we should look up the struct definition and build an object.
    const structDef = this.context.ir.structs?.find(s => s.id === type);
    if (structDef) {
      const obj: any = {};
      for (const m of structDef.members) {
        obj[m.name] = this.constructDefaultValue(m.type);
      }
      return obj;
    }

    // Fallback
    return 0;
  }
}
