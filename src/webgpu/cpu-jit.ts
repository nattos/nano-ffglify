import { FunctionDef, Node } from '../ir/types';
import { RuntimeGlobals } from './host-interface';

/**
 * CPU JIT Compiler for WebGPU Host
 * Compiles IR Functions into flat JavaScript for high-performance execution.
 */
export class CpuJitCompiler {

  /**
   * Compiles an IR function into a native JS function.
   * Signature: (resources: Map<string, ResourceState>, inputs: Map<string, RuntimeValue>, globals: RuntimeGlobals) => Promise<RuntimeValue>
   */
  compile(func: FunctionDef, allFunctions: FunctionDef[] = []): Function {
    const lines: string[] = [];

    lines.push(`"use strict";`);
    lines.push(`// Compiled Function: ${func.id}`);

    const sanitizeId = (id: string) => `v_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const nodeResId = (id: string) => `n_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // 1. Local Variables
    // Declared at top level of function scope
    if (func.localVars.length) {
      lines.push(`// Locals`);
      for (const v of func.localVars) {
        const init = v.initialValue !== undefined ? JSON.stringify(v.initialValue) : '0';
        lines.push(`let ${sanitizeId(v.id)} = ${init};`);
      }
    }

    // 2. Result Variables for all nodes that return data
    const resultVars = func.nodes
      .filter(n => this.hasResult(n.op))
      .map(n => `let ${nodeResId(n.id)};`);

    if (resultVars.length) {
      lines.push(`// Node Results`);
      lines.push(...resultVars);
    }

    // 2.5. Evaluate Pure Nodes (those not in the execution chain)
    lines.push(`// Pure Nodes`);
    for (const node of func.nodes) {
      if (this.hasResult(node.op) && !this.isExecutable(node.op)) {
        lines.push(`${nodeResId(node.id)} = ${this.compileExpression(node, func, sanitizeId, nodeResId, allFunctions, true)};`);
      }
    }

    // 3. Find Entry Nodes
    const entryNodes = func.nodes.filter(n => {
      const hasExecIn = func.edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op);
    });

    // 4. Emit Body
    for (const entry of entryNodes) {
      this.emitChain(entry, func, lines, new Set(), sanitizeId, nodeResId, allFunctions);
    }

    const body = lines.join('\n');
    try {
      // Compiled functions are always async since they might dispatch GPU shaders
      const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
      return new AsyncFunction('resources', 'variables', 'globals', 'state', body);
    } catch (e) {
      console.error("JIT Compilation Failed:\n", body);
      throw e;
    }
  }

  private isExecutable(op: string) {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'texture_store' || op === 'call_func' || op === 'func_return' || op === 'array_set';
  }

  private hasResult(op: string) {
    const valueOps = [
      'float', 'int', 'uint', 'bool',
      'float2', 'float3', 'float4',
      'float3x3', 'float4x4',
      'mat_mul', 'mat_extract',
      'static_cast_float', 'static_cast_int', 'static_cast_uint', 'static_cast_bool',
      'struct_construct', 'struct_extract',
      'array_construct', 'array_extract', 'array_set',
      'var_get', 'buffer_load', 'texture_load', 'call_func'
    ];
    return valueOps.includes(op) || op.startsWith('math_') || op.startsWith('vec_');
  }

  private emitChain(startNode: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, allFunctions: FunctionDef[]) {
    let curr: Node | undefined = startNode;

    while (curr) {
      if (visited.has(curr.id) && curr.op !== 'flow_loop') {
        lines.push(`// Merge point: ${curr.id}`);
      }
      visited.add(curr.id);

      if (curr.op === 'flow_branch') {
        this.emitBranch(curr, func, lines, visited, sanitizeId, nodeResId, allFunctions);
        return;
      } else if (curr.op === 'flow_loop') {
        this.emitLoop(curr, func, lines, visited, sanitizeId, nodeResId, allFunctions);
        return;
      } else if (curr.op === 'func_return') {
        lines.push(`return ${this.resolveArg(curr, 'val', func, sanitizeId, nodeResId, allFunctions)};`);
        return;
      } else {
        this.emitNode(curr, func, lines, sanitizeId, nodeResId, allFunctions);
      }

      curr = this.getNextNode(curr, 'exec_out', func);
    }
  }

  private emitBranch(node: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, allFunctions: FunctionDef[]) {
    const cond = this.resolveArg(node, 'cond', func, sanitizeId, nodeResId, allFunctions);
    lines.push(`if (${cond}) {`);
    const trueNode = this.getNextNode(node, 'exec_true', func);
    if (trueNode) this.emitChain(trueNode, func, lines, new Set(visited), sanitizeId, nodeResId, allFunctions);
    lines.push(`} else {`);
    const falseNode = this.getNextNode(node, 'exec_false', func);
    if (falseNode) this.emitChain(falseNode, func, lines, new Set(visited), sanitizeId, nodeResId, allFunctions);
    lines.push(`}`);
  }

  private emitLoop(node: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, allFunctions: FunctionDef[]) {
    const start = this.resolveArg(node, 'start', func, sanitizeId, nodeResId, allFunctions);
    const end = this.resolveArg(node, 'end', func, sanitizeId, nodeResId, allFunctions);
    const loopVar = `loop_${node.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    lines.push(`for (let ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);

    const bodyNode = this.getNextNode(node, 'exec_body', func);
    if (bodyNode) this.emitChain(bodyNode, func, lines, new Set(visited), sanitizeId, nodeResId, allFunctions);
    lines.push(`}`);

    const nextNode = this.getNextNode(node, 'exec_completed', func);
    if (nextNode) this.emitChain(nextNode, func, lines, visited, sanitizeId, nodeResId, allFunctions);
  }

  private emitNode(node: Node, func: FunctionDef, lines: string[], sanitizeId: (id: string) => string, nodeResId: (id: string) => string, allFunctions: FunctionDef[]) {
    if (node.op === 'cmd_dispatch') {
      const targetId = node['func'];
      let dimCode = '[1, 1, 1]';
      if (Array.isArray(node['dispatch'])) dimCode = JSON.stringify(node['dispatch']);
      lines.push(`await globals.dispatch('${targetId}', ${dimCode}, ${this.generateArgsObject(node, func, sanitizeId, nodeResId, allFunctions)});`);
    }
    else if (node.op === 'call_func') {
      const targetId = node['func'];
      const targetFunc = allFunctions.find(f => f.id === targetId);
      if (targetFunc?.type === 'shader') {
        lines.push(`await globals.dispatch('${targetId}', [1, 1, 1], ${this.generateArgsObject(node, func, sanitizeId, nodeResId, allFunctions)});`);
      } else {
        lines.push(`${nodeResId(node.id)} = await globals.callOp('call_func', ${this.generateArgsObject(node, func, sanitizeId, nodeResId, allFunctions)});`);
      }
    }
    else if (node.op === 'cmd_draw') {
      const target = node['target'];
      const vertex = node['vertex'];
      const fragment = node['fragment'];
      const count = this.resolveArg(node, 'count', func, sanitizeId, nodeResId, allFunctions);
      const pipeline = JSON.stringify(node['pipeline'] || {});
      lines.push(`await globals.draw('${target}', '${vertex}', '${fragment}', ${count}, ${pipeline});`);
    }
    else if (node.op === 'cmd_resize_resource') {
      const resId = node['resource'];
      const size = this.resolveArg(node, 'size', func, sanitizeId, nodeResId, allFunctions);
      const resolveRaw = (key: string) => {
        const edge = func.edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
        if (edge || node[key] !== undefined) return this.resolveArg(node, key, func, sanitizeId, nodeResId, allFunctions);
        return 'undefined';
      };
      const format = resolveRaw('format');
      const clear = resolveRaw('clear');
      lines.push(`globals.resize('${resId}', ${size}, ${format}, ${clear});`);
    }
    else if (node.op === 'var_set') {
      const val = this.resolveArg(node, 'val', func, sanitizeId, nodeResId, allFunctions);
      const varId = node['var'];
      if (func.localVars.some(v => v.id === varId)) {
        lines.push(`${sanitizeId(varId)} = ${val};`);
      } else {
        lines.push(`variables.set('${varId}', ${val});`);
      }
    }
    else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'];
      const idx = this.resolveArg(node, 'index', func, sanitizeId, nodeResId, allFunctions);
      const val = this.resolveArg(node, 'value', func, sanitizeId, nodeResId, allFunctions);
      lines.push(`resources.get('${bufferId}').data[${idx}] = ${val};`);
    }
    else if (this.hasResult(node.op)) {
      // Calculation node in execution chain
      lines.push(`${nodeResId(node.id)} = await globals.callOp('${node.op}', ${this.generateArgsObject(node, func, sanitizeId, nodeResId, allFunctions)});`);
    }
    else {
      lines.push(`// Not implemented or pure node in chain: ${node.op}`);
    }
  }

  private getNextNode(node: Node, port: string, func: FunctionDef): Node | undefined {
    const edge = func.edges.find(e => e.from === node.id && e.portOut === port && e.type === 'execution');
    if (!edge) return undefined;
    return func.nodes.find(n => n.id === edge.to);
  }

  private resolveArg(node: Node, key: string, func: FunctionDef, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, allFunctions: FunctionDef[]): string {
    const edge = func.edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
    if (edge) {
      const source = func.nodes.find(n => n.id === edge.from);
      if (source) return this.compileExpression(source, func, sanitizeId, nodeResId, allFunctions);
    }

    if (node[key] !== undefined) {
      const val = node[key];
      if (typeof val === 'string' && key !== 'var' && key !== 'func' && key !== 'resource' && key !== 'buffer') {
        if (func.localVars.some(v => v.id === val)) return sanitizeId(val);
        const targetNode = func.nodes.find(n => n.id === val);
        if (targetNode && targetNode.id !== node.id) return this.compileExpression(targetNode, func, sanitizeId, nodeResId, allFunctions);
        return `globals.resolveString('${val}')`;
      }
      return JSON.stringify(val);
    }
    return '0';
  }

  private compileExpression(node: Node, func: FunctionDef, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, allFunctions: FunctionDef[], forceEmit: boolean = false): string {
    if (!forceEmit && this.hasResult(node.op)) {
      return nodeResId(node.id);
    }
    if (node.op === 'var_get') {
      const varId = node['var'];
      if (func.localVars.some(v => v.id === varId)) return sanitizeId(varId);
      return `(variables.has('${varId}') ? variables.get('${varId}') : globals.resolveVar('${varId}'))`;
    }
    if (node.op === 'literal') return JSON.stringify(node['val']);
    if (node.op === 'loop_index') {
      const loopId = node['loop'];
      return `loop_${loopId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    }
    if (node.op === 'buffer_load') {
      const bufferId = node['buffer'];
      const idx = this.resolveArg(node, 'index', func, sanitizeId, nodeResId, allFunctions);
      return `(resources.get('${bufferId}') ? resources.get('${bufferId}').data[${idx}] : 0)`;
    }

    // Generic Built-in Op
    return `globals.callOp('${node.op}', ${this.generateArgsObject(node, func, sanitizeId, nodeResId, allFunctions)})`;
  }

  private generateArgsObject(node: Node, func: FunctionDef, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, allFunctions: FunctionDef[]): string {
    const parts: string[] = [];

    if (node.op === 'call_func' || node.op === 'cmd_dispatch') {
      const targetId = node['func'];
      const targetFunc = allFunctions.find(f => f.id === targetId);
      const posArgs = node['args'];
      if (targetFunc && Array.isArray(posArgs)) {
        posArgs.forEach((argVal, idx) => {
          const input = targetFunc.inputs[idx];
          if (input) {
            // Positional arg might be a node ID or literal
            let expr = '0';
            if (typeof argVal === 'string') {
              if (func.localVars.some(v => v.id === argVal)) expr = sanitizeId(argVal);
              else {
                const targetNode = func.nodes.find(n => n.id === argVal);
                if (targetNode) expr = this.compileExpression(targetNode, func, sanitizeId, nodeResId, allFunctions);
                else {
                  // Fallback to resolving from globals/inputs
                  expr = `(variables.has('${argVal}') ? variables.get('${argVal}') : globals.resolveVar('${argVal}'))`;
                }
              }
            } else {
              expr = JSON.stringify(argVal);
            }
            parts.push(`'${input.id}': ${expr}`);
          }
        });
        return `{ ${parts.join(', ')} }`;
      }
    }

    const inputs = func.edges.filter(e => e.to === node.id && e.type === 'data');
    const inputKeys = new Set(inputs.map(e => e.portIn));

    for (const edge of inputs) {
      const src = func.nodes.find(n => n.id === edge.from);
      if (src) parts.push(`'${edge.portIn}': ${this.compileExpression(src, func, sanitizeId, nodeResId, allFunctions)}`);
    }

    for (const key of Object.keys(node)) {
      if (['id', 'op', 'metadata', 'const_data'].includes(key)) continue;
      if (inputKeys.has(key)) continue;
      parts.push(`'${key}': ${this.resolveArg(node, key, func, sanitizeId, nodeResId, allFunctions)}`);
    }

    return `{ ${parts.join(', ')} }`;
  }
}
