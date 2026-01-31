import { IRDocument, Node, FunctionDef, Edge, RenderPipelineDef } from '../ir/types';
import { EvaluationContext, RuntimeValue } from './context';
import { OpRegistry } from './ops';
import { SoftwareRasterizer } from './rasterizer';

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
    this.executeFunction(entryFunc);
    this.context.popFrame();
  }

  executeFunction(func: FunctionDef): RuntimeValue | void {
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
      const hasExecIn = func.edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutableNode(n);
    });

    const executionQueue: Node[] = [...entryNodes];

    // BFS / Flow Execution
    while (executionQueue.length > 0) {
      const node = executionQueue.shift()!;

      const result = this.executeNode(node, func);

      if (node.op === 'func_return') {
        return result;
      }

      if (node.op === 'flow_branch') {
        this.handleBranch(node, func, executionQueue);
      } else if (node.op === 'flow_loop') {
        this.handleLoop(node, func, executionQueue);
      } else {
        this.continueFlow(node, 'exec_out', func, executionQueue);
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

  protected executeNode(node: Node, func: FunctionDef): RuntimeValue | void {
    const opId = node.op;

    if (opId === 'flow_branch' || opId === 'flow_loop') return;

    if (opId === 'cmd_dispatch') {
      const targetId = node.func as string;
      const args: Record<string, RuntimeValue> = {};
      this.mixinNodeProperties(node, args, func);

      const dim: [number, number, number] = [1, 1, 1];
      if (Array.isArray(args.dispatch)) {
        const d = args.dispatch as unknown as any[];
        dim[0] = d[0] || 1;
        dim[1] = d[1] || 1;
        dim[2] = d[2] || 1;
      }

      const targetFunc = this.context.ir.functions.find(f => f.id === targetId);
      if (targetFunc) {
        for (let z = 0; z < dim[2]; z++) {
          for (let y = 0; y < dim[1]; y++) {
            for (let x = 0; x < dim[0]; x++) {
              this.context.builtins.set('global_invocation_id', [x, y, z]);
              this.context.builtins.set('local_invocation_id', [x, y, z]); // For now 1:1 with global
              this.context.builtins.set('workgroup_id', [0, 0, 0]);
              this.context.builtins.set('local_invocation_index', 0);
              this.context.builtins.set('num_workgroups', dim);
              this.context.pushFrame(targetId);

              // Set arguments into the shader frame
              if (targetFunc.inputs) {
                for (const inputDef of targetFunc.inputs) {
                  const val = args[inputDef.id];
                  if (val !== undefined) {
                    // String to shader error
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
      this.mixinNodeProperties(node, args, func);

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

      const args: Record<string, RuntimeValue> = {};
      this.mixinNodeProperties(node, args, func);

      this.context.pushFrame(targetId);

      if (targetFunc.inputs) {
        for (const inputDef of targetFunc.inputs) {
          const val = args[inputDef.id];
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
      this.mixinNodeProperties(node, args, func);
      const result = handler(this.context, args as any); // any cast is valid, since Zod has already validated these args match the op.
      if (result !== undefined) {
        this.context.currentFrame.nodeResults.set(node.id, result);
      }
      return result;
    }
  }

  private continueFlow(node: Node, port: string, func: FunctionDef, queue: Node[]) {
    const nextEdges = func.edges.filter(e => e.from === node.id && e.portOut === port && e.type === 'execution');
    for (const edge of nextEdges) {
      const nextNode = func.nodes.find(n => n.id === edge.to);
      if (nextNode) queue.push(nextNode);
    }
  }

  private handleBranch(node: Node, func: FunctionDef, queue: Node[]) {
    const args: any = {};
    this.mixinNodeProperties(node, args, func);
    const condVal = !!args.cond;

    if (condVal) {
      this.continueFlow(node, 'exec_true', func, queue);
    } else {
      this.continueFlow(node, 'exec_false', func, queue);
    }
  }

  private handleLoop(node: Node, func: FunctionDef, queue: Node[]) {
    const args: any = {};
    this.mixinNodeProperties(node, args, func);
    const start = args.start as number;
    const end = args.end as number;

    for (let i = start; i < end; i++) {
      this.context.setLoopIndex(node.id, i);
      // Clear node result cache to ensure nodes inside loop are re-evaluated
      this.context.currentFrame.nodeResults.clear();

      const bodyEdges = func.edges.filter(e => e.from === node.id && e.portOut === 'exec_body' && e.type === 'execution');
      for (const edge of bodyEdges) {
        const bodyNode = func.nodes.find(n => n.id === edge.to);
        if (bodyNode) {
          this.executeChain(bodyNode, func);
        }
      }
    }

    this.continueFlow(node, 'exec_completed', func, queue);
  }

  private executeChain(startNode: Node, func: FunctionDef) {
    const q = [startNode];
    while (q.length) {
      const n = q.shift()!;
      this.executeNode(n, func);

      if (n.op === 'func_return') {
        // Ignoring return in loop for now
      }

      if (n.op === 'flow_branch') {
        this.handleBranch(n, func, q);
      } else if (n.op === 'flow_loop') {
        this.handleLoop(n, func, q);
      } else {
        this.continueFlow(n, 'exec_out', func, q);
      }
    }
  }

  protected resolveNodeValue(node: Node | string, func: FunctionDef): RuntimeValue {
    if (typeof node === 'string') {
      const v = this.context.getVar(node);
      if (v !== undefined) return v;
      try { return this.context.getInput(node); } catch { return 0; }
    }

    if (this.context.currentFrame.nodeResults.has(node.id)) {
      return this.context.currentFrame.nodeResults.get(node.id)!;
    }

    const args: Record<string, RuntimeValue> = {};
    this.mixinNodeProperties(node, args, func);

    const handler = OpRegistry[node.op as keyof typeof OpRegistry];
    if (handler) {
      const result = handler(this.context, args as any); // any cast is valid, since Zod has already validated these args match the op.
      if (result !== undefined && node.op !== 'loop_index') {
        this.context.currentFrame.nodeResults.set(node.id, result);
      }
      return result ?? 0;
    }
    return 0;
  }

  protected mixinNodeProperties(node: Node, args: Record<string, RuntimeValue>, func: FunctionDef) {
    const SKIP_RESOLUTION = ['var', 'func', 'resource', 'buffer', 'tex', 'loop', 'type', 'field', 'member', 'channels', 'mask', 'target', 'vertex', 'fragment', 'name'];

    // 1. Resolve Props
    for (const key of Object.keys(node)) {
      if (['id', 'op', 'metadata', 'const_data'].includes(key)) continue;
      if (args[key] === undefined) {
        let val = node[key];

        if (SKIP_RESOLUTION.includes(key)) {
          args[key] = val;
          continue;
        }

        if (typeof val === 'string') {
          const varVal = this.context.getVar(val);
          if (varVal !== undefined) {
            val = varVal;
          } else {
            try {
              val = this.context.getInput(val);
            } catch (e) {
              // Try resolving as a node ID in the current function if it's not a var/input
              // Recursion guard: don't resolve yourself
              if (val !== node.id) {
                const targetNode = func.nodes.find(n => n.id === val);
                if (targetNode) {
                  val = this.resolveNodeValue(targetNode, func);
                }
              }
            }
          }
        }
        args[key] = val;
      }
    }

    // 2. Resolve Edges
    const incomingEdges = func.edges.filter(e => e.to === node.id && e.type === 'data');
    for (const edge of incomingEdges) {
      const sourceNode = func.nodes.find(n => n.id === edge.from);
      if (sourceNode) {
        args[edge.portIn] = this.resolveNodeValue(sourceNode, func);
      }
    }
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
