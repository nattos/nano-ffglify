import { FunctionDef, Node } from '../ir/types';
import { RuntimeGlobals } from './host-interface';

/**
 * CPU JIT Compiler for WebGPU Host
 * Compiles IR Functions into flat JavaScript for high-performance execution.
 */
export class CpuJitCompiler {

  /**
   * Compiles an IR function (and its dependencies) into a native JS function.
   * Signature: (resources, inputs, globals, variables) => Promise<RuntimeValue>
   */
  compile(func: FunctionDef, allFunctions: FunctionDef[] = []): Function {
    const lines: string[] = [];

    lines.push(`"use strict";`);
    lines.push(`// Compiled Graph starting at: ${func.id}`);

    const sanitizeId = (id: string) => `v_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const nodeResId = (id: string) => `n_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const funcName = (id: string) => `func_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // Add common helpers for vector/matrix math
    this.emitIntrinsicHelpers(lines);

    // 1. Collect all reachable CPU functions
    const reachable = new Set<string>();
    const toVisit = [func.id];
    while (toVisit.length > 0) {
      const fid = toVisit.pop()!;
      if (reachable.has(fid)) continue;
      reachable.add(fid);
      const f = allFunctions.find(func => func.id === fid);
      if (f) {
        f.nodes.forEach(n => {
          if (n.op === 'call_func' && typeof n.func === 'string') {
            const target = allFunctions.find(tf => tf.id === n.func);
            if (target && target.type === 'cpu') toVisit.push(n.func);
          }
        });
      }
    }

    // 2. Emit each reachable function as a nested JS function
    for (const fid of reachable) {
      const f = allFunctions.find(func => func.id === fid);
      if (f) {
        this.emitFunction(f, lines, sanitizeId, nodeResId, funcName, allFunctions);
        lines.push('');
      }
    }

    // 3. Main wrapper body
    // Map initial inputs to the entry function arguments
    lines.push(`// Entry Point`);
    lines.push(`const entryInputs = {};`);
    for (const input of func.inputs) {
      lines.push(`entryInputs['${input.id}'] = inputs.has('${input.id}') ? inputs.get('${input.id}') : undefined;`);
    }
    lines.push(`return await ${funcName(func.id)}(entryInputs);`);

    const body = lines.join('\n');
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
      return new AsyncFunction('resources', 'inputs', 'globals', 'variables', body);
    } catch (e) {
      console.error("JIT Compilation Failed:\n", body);
      throw e;
    }
  }

  private emitIntrinsicHelpers(lines: string[]) {
    lines.push(`// Intrinsics`);
    lines.push(`const _vec_dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);`);
    lines.push(`const _vec_length = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));`);
    lines.push(`const _vec_normalize = (a) => { const l = _vec_length(a); return l < 1e-10 ? a.map(() => 0) : a.map(v => v / l); };`);
    lines.push(`const _mat_mul = (a, b) => {
      const dim = a.length === 16 ? 4 : 3;
      if (b.length === a.length) {
        const out = new Array(dim * dim);
        for (let r = 0; r < dim; r++) for (let c = 0; c < dim; c++) {
          let sum = 0; for (let k = 0; k < dim; k++) sum += a[k * dim + r] * b[c * dim + k];
          out[c * dim + r] = sum;
        }
        return out;
      }
      if (b.length === dim) {
        const out = new Array(dim).fill(0);
        for (let r = 0; r < dim; r++) {
          let sum = 0; for (let c = 0; c < dim; c++) sum += a[c * dim + r] * b[c];
          out[r] = sum;
        }
        return out;
      }
      return 0;
    };`);
  }

  private emitFunction(f: FunctionDef, lines: string[], sanitizeId: (id: string) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[]) {
    lines.push(`async function ${funcName(f.id)}(args) {`);

    // Unpack args into local vars
    for (const input of f.inputs) {
      lines.push(`  let ${sanitizeId(input.id)} = args['${input.id}'];`);
    }

    // Local Variables
    for (const v of f.localVars) {
      const init = v.initialValue !== undefined ? JSON.stringify(v.initialValue) : '0';
      lines.push(`  let ${sanitizeId(v.id)} = ${init};`);
    }

    // Node Result Variables
    const resultNodes = f.nodes.filter(n => this.hasResult(n.op));
    for (const n of resultNodes) {
      lines.push(`  let ${nodeResId(n.id)};`);
    }

    // Compile node logic
    // For simplicity, we can unroll everything in order or follow execution chain
    // Pure nodes first (can be evaluated as needed or pre-evaluated)
    lines.push(`  // Pure Nodes`);
    for (const node of f.nodes) {
      if (this.hasResult(node.op) && !this.isExecutable(node.op)) {
        lines.push(`  ${nodeResId(node.id)} = ${this.compileExpression(node, f, sanitizeId, nodeResId, funcName, allFunctions, true)};`);
      }
    }

    // Execution Chain
    const entryNodes = f.nodes.filter(n => {
      const hasExecIn = f.edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op);
    });

    for (const entry of entryNodes) {
      this.emitChain('  ', entry, f, lines, new Set(), sanitizeId, nodeResId, funcName, allFunctions);
    }

    lines.push(`  return 0; // Default return`);
    lines.push(`}`);
  }

  private isExecutable(op: string) {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'texture_store' || op === 'call_func' || op === 'func_return' || op === 'array_set';
  }

  private hasResult(op: string) {
    const valueOps = [
      'float', 'int', 'uint', 'bool', 'literal',
      'float2', 'float3', 'float4',
      'float3x3', 'float4x4',
      'mat_mul', 'mat_extract',
      'static_cast_float', 'static_cast_int', 'static_cast_uint', 'static_cast_bool',
      'struct_construct', 'struct_extract',
      'array_construct', 'array_extract', 'array_length',
      'var_get', 'buffer_load', 'texture_load', 'call_func', 'vec_swizzle'
    ];
    return valueOps.includes(op) || op.startsWith('math_') || op.startsWith('vec_');
  }

  private emitChain(indent: string, startNode: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[]) {
    let curr: Node | undefined = startNode;

    while (curr) {
      if (visited.has(curr.id)) {
        if (curr.op !== 'flow_loop') break;
      }
      visited.add(curr.id);

      if (curr.op === 'flow_branch') {
        this.emitBranch(indent, curr, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions);
        return;
      } else if (curr.op === 'flow_loop') {
        this.emitLoop(indent, curr, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions);
        return;
      } else if (curr.op === 'func_return') {
        lines.push(`${indent}return ${this.resolveArg(curr, 'val', func, sanitizeId, nodeResId, funcName, allFunctions)};`);
        return;
      } else {
        this.emitNode(indent, curr, func, lines, sanitizeId, nodeResId, funcName, allFunctions);
      }

      curr = this.getNextNode(curr, 'exec_out', func);
    }
  }

  private emitBranch(indent: string, node: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[]) {
    const cond = this.resolveArg(node, 'cond', func, sanitizeId, nodeResId, funcName, allFunctions);
    lines.push(`${indent}if (${cond}) {`);
    const trueNode = this.getNextNode(node, 'exec_true', func);
    if (trueNode) this.emitChain(indent + '  ', trueNode, func, lines, new Set(visited), sanitizeId, nodeResId, funcName, allFunctions);
    lines.push(`${indent}} else {`);
    const falseNode = this.getNextNode(node, 'exec_false', func);
    if (falseNode) this.emitChain(indent + '  ', falseNode, func, lines, new Set(visited), sanitizeId, nodeResId, funcName, allFunctions);
    lines.push(`${indent}}`);
  }

  private emitLoop(indent: string, node: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[]) {
    const start = this.resolveArg(node, 'start', func, sanitizeId, nodeResId, funcName, allFunctions);
    const end = this.resolveArg(node, 'end', func, sanitizeId, nodeResId, funcName, allFunctions);
    const loopVar = `loop_${node.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    lines.push(`${indent}for (let ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);

    const bodyNode = this.getNextNode(node, 'exec_body', func);
    if (bodyNode) this.emitChain(indent + '  ', bodyNode, func, lines, new Set(visited), sanitizeId, nodeResId, funcName, allFunctions);
    lines.push(`${indent}}`);

    const nextNode = this.getNextNode(node, 'exec_completed', func);
    if (nextNode) this.emitChain(indent, nextNode, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions);
  }

  private emitNode(indent: string, node: Node, func: FunctionDef, lines: string[], sanitizeId: (id: string) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[]) {
    if (node.op === 'cmd_dispatch') {
      const targetId = node['func'];
      const dimCode = Array.isArray(node['dispatch']) ? JSON.stringify(node['dispatch']) : '[1, 1, 1]';
      lines.push(`${indent}await globals.dispatch('${targetId}', ${dimCode}, ${this.generateArgsObject(node, func, sanitizeId, nodeResId, funcName, allFunctions)});`);
    }
    else if (node.op === 'call_func') {
      const targetId = node['func'];
      const targetFunc = allFunctions.find(f => f.id === targetId);
      if (targetFunc?.type === 'shader') {
        lines.push(`${indent}await globals.dispatch('${targetId}', [1, 1, 1], ${this.generateArgsObject(node, func, sanitizeId, nodeResId, funcName, allFunctions)});`);
      } else if (targetFunc) {
        lines.push(`${indent}${nodeResId(node.id)} = await ${funcName(targetId)}(${this.generateArgsObject(node, func, sanitizeId, nodeResId, funcName, allFunctions)});`);
      }
    }
    else if (node.op === 'cmd_draw') {
      const target = node['target'];
      const vertex = node['vertex'];
      const fragment = node['fragment'];
      const count = this.resolveArg(node, 'count', func, sanitizeId, nodeResId, funcName, allFunctions);
      const pipeline = JSON.stringify(node['pipeline'] || {});
      lines.push(`${indent}await globals.draw('${target}', '${vertex}', '${fragment}', ${count}, ${pipeline});`);
    }
    else if (node.op === 'cmd_resize_resource') {
      const resId = node['resource'];
      const size = this.resolveArg(node, 'size', func, sanitizeId, nodeResId, funcName, allFunctions);
      const resolveRaw = (key: string) => {
        const edge = func.edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
        if (edge || node[key] !== undefined) return this.resolveArg(node, key, func, sanitizeId, nodeResId, funcName, allFunctions);
        return 'undefined';
      };
      lines.push(`${indent}globals.resize('${resId}', ${size}, ${resolveRaw('format')}, ${resolveRaw('clear')});`);
    }
    else if (node.op === 'var_set') {
      const val = this.resolveArg(node, 'val', func, sanitizeId, nodeResId, funcName, allFunctions);
      const varId = node['var'];
      if (func.localVars.some(v => v.id === varId)) lines.push(`${indent}${sanitizeId(varId)} = ${val};`);
      else lines.push(`${indent}variables.set('${varId}', ${val});`);
    }
    else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'];
      const idx = this.resolveArg(node, 'index', func, sanitizeId, nodeResId, funcName, allFunctions);
      const val = this.resolveArg(node, 'value', func, sanitizeId, nodeResId, funcName, allFunctions);
      lines.push(`${indent}resources.get('${bufferId}').data[${idx}] = ${val};`);
    }
    else if (this.hasResult(node.op)) {
      lines.push(`${indent}${nodeResId(node.id)} = ${this.compileExpression(node, func, sanitizeId, nodeResId, funcName, allFunctions, true)};`);
    }
  }

  private getNextNode(node: Node, port: string, func: FunctionDef): Node | undefined {
    const edge = func.edges.find(e => e.from === node.id && e.portOut === port && e.type === 'execution');
    return edge ? func.nodes.find(n => n.id === edge.to) : undefined;
  }

  private resolveArg(node: Node, key: string, func: FunctionDef, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[]): string {
    const edge = func.edges.find(e => e.to === node.id && (e.portIn === key || (key === 'val' && e.portIn === 'value')) && e.type === 'data');
    if (edge) {
      const source = func.nodes.find(n => n.id === edge.from);
      if (source) return this.compileExpression(source, func, sanitizeId, nodeResId, funcName, allFunctions);
    }

    if (node[key] !== undefined || (key === 'val' && node['value'] !== undefined)) {
      const val = (node[key] !== undefined) ? node[key] : node['value'];
      if (typeof val === 'string' && !['var', 'func', 'resource', 'buffer'].includes(key)) {
        if (func.localVars.some(v => v.id === val)) return sanitizeId(val);
        const targetNode = func.nodes.find(n => n.id === val);
        if (targetNode && targetNode.id !== node.id) return this.compileExpression(targetNode, func, sanitizeId, nodeResId, funcName, allFunctions);
      }
      return JSON.stringify(val);
    }
    return '0';
  }

  private compileExpression(node: Node, func: FunctionDef, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], forceEmit: boolean = false): string {
    if (!forceEmit && this.hasResult(node.op)) return nodeResId(node.id);

    const a = (k = 'a') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions);
    const b = (k = 'b') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions);
    const val = (k = 'val') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions);

    switch (node.op) {
      case 'var_get': {
        const varId = node['var'];
        if (func.localVars.some(v => v.id === varId)) return sanitizeId(varId);
        return `(variables.has('${varId}') ? variables.get('${varId}') : undefined)`;
      }
      case 'literal': return JSON.stringify(node['val']);
      case 'loop_index': return `loop_${node['loop'].replace(/[^a-zA-Z0-9_]/g, '_')}`;
      case 'buffer_load': {
        const bufferId = node['buffer'];
        const idx = a('index');
        return `(resources.get('${bufferId}') ? resources.get('${bufferId}').data[${idx}] : 0)`;
      }

      // Basic Math
      case 'math_add': return `(${a()} + ${b()})`;
      case 'math_sub': return `(${a()} - ${b()})`;
      case 'math_mul': return `(${a()} * ${b()})`;
      case 'math_div': return `(${a()} / ${b()})`;
      case 'math_mod': return `(${a()} % ${b()})`;
      case 'math_neg': return `(-${val()})`;
      case 'math_abs': return `Math.abs(${val()})`;
      case 'math_sin': return `Math.sin(${val()})`;
      case 'math_cos': return `Math.cos(${val()})`;
      case 'math_tan': return `Math.tan(${val()})`;
      case 'math_sqrt': return `Math.sqrt(${val()})`;
      case 'math_exp': return `Math.exp(${val()})`;
      case 'math_log': return `Math.log(${val()})`;
      case 'math_pow': return `Math.pow(${a()}, ${b()})`;
      case 'math_min': return `Math.min(${a()}, ${b()})`;
      case 'math_max': return `Math.max(${a()}, ${b()})`;
      case 'math_clamp': return `Math.min(Math.max(${val()}, ${this.resolveArg(node, 'min', func, sanitizeId, nodeResId, funcName, allFunctions)}), ${this.resolveArg(node, 'max', func, sanitizeId, nodeResId, funcName, allFunctions)})`;

      // Comparison
      case 'math_gt': return `(${a()} > ${b()})`;
      case 'math_lt': return `(${a()} < ${b()})`;
      case 'math_ge': return `(${a()} >= ${b()})`;
      case 'math_le': return `(${a()} <= ${b()})`;
      case 'math_eq': return `(${a()} === ${b()})`;
      case 'math_neq': return `(${a()} !== ${b()})`;

      // Casts
      case 'static_cast_float': return `Number(${val()})`;
      case 'static_cast_int': return `Math.floor(${val()})`;
      case 'static_cast_bool': return `Boolean(${val()})`;

      // Vectors
      case 'float2': return `[${this.resolveArg(node, 'x', func, sanitizeId, nodeResId, funcName, allFunctions)}, ${this.resolveArg(node, 'y', func, sanitizeId, nodeResId, funcName, allFunctions)}]`;
      case 'float3': return `[${this.resolveArg(node, 'x', func, sanitizeId, nodeResId, funcName, allFunctions)}, ${this.resolveArg(node, 'y', func, sanitizeId, nodeResId, funcName, allFunctions)}, ${this.resolveArg(node, 'z', func, sanitizeId, nodeResId, funcName, allFunctions)}]`;
      case 'float4': return `[${this.resolveArg(node, 'x', func, sanitizeId, nodeResId, funcName, allFunctions)}, ${this.resolveArg(node, 'y', func, sanitizeId, nodeResId, funcName, allFunctions)}, ${this.resolveArg(node, 'z', func, sanitizeId, nodeResId, funcName, allFunctions)}, ${this.resolveArg(node, 'w', func, sanitizeId, nodeResId, funcName, allFunctions)}]`;
      case 'vec_dot': return `_vec_dot(${a()}, ${b()})`;
      case 'vec_length': return `_vec_length(${a()})`;
      case 'vec_normalize': return `_vec_normalize(${a()})`;
      case 'vec_swizzle': {
        const vec = this.resolveArg(node, 'vec', func, sanitizeId, nodeResId, funcName, allFunctions);
        const channels = node['channels'] || node['swizzle'] || 'x';
        const map: any = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
        const idxs = channels.split('').map((c: string) => map[c]);
        if (idxs.length === 1) return `${vec}[${idxs[0]}]`;
        return `[${idxs.map((i: number) => `${vec}[${i}]`).join(', ')}]`;
      }

      // Structs
      case 'struct_construct': {
        const parts = [];
        for (const k in node) {
          if (['id', 'op', 'metadata', 'const_data', 'type'].includes(k)) continue;
          parts.push(`'${k}': ${this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions)}`);
        }
        return `{ ${parts.join(', ')} }`;
      }
      case 'struct_extract': return `(${this.resolveArg(node, 'struct', func, sanitizeId, nodeResId, funcName, allFunctions)}['${node['field'] || node['member']}'])`;

      // Arrays
      case 'array_construct': {
        if (node['values']) return JSON.stringify(node['values']);
        const len = this.resolveArg(node, 'length', func, sanitizeId, nodeResId, funcName, allFunctions);
        const fill = this.resolveArg(node, 'fill', func, sanitizeId, nodeResId, funcName, allFunctions);
        return `new Array(${len}).fill(${fill})`;
      }
      case 'array_extract': return `${this.resolveArg(node, 'array', func, sanitizeId, nodeResId, funcName, allFunctions)}[${a('index')}]`;
      case 'array_length': return `(${this.resolveArg(node, 'array', func, sanitizeId, nodeResId, funcName, allFunctions)}.length)`;

      default: return '0';
    }
  }

  private generateArgsObject(node: Node, func: FunctionDef, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[]): string {
    const parts: string[] = [];
    const targetId = node['func'];
    const targetFunc = allFunctions.find(f => f.id === targetId);

    if (targetFunc) {
      targetFunc.inputs.forEach((input, idx) => {
        let valExpr = '0';
        if (node['args'] && node['args'][idx] !== undefined) valExpr = JSON.stringify(node['args'][idx]);
        else valExpr = this.resolveArg(node, input.id, func, sanitizeId, nodeResId, funcName, allFunctions);
        parts.push(`'${input.id}': ${valExpr}`);
      });
    } else {
      for (const k in node) {
        if (['id', 'op', 'metadata', 'const_data', 'func', 'args', 'dispatch'].includes(k)) continue;
        parts.push(`'${k}': ${this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions)}`);
      }
    }
    return `{ ${parts.join(', ')} }`;
  }
}
