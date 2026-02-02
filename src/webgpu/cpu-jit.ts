import { IRDocument, FunctionDef, Node, Edge } from '../ir/types';
import { reconstructEdges } from '../ir/utils';
import { RuntimeGlobals } from './host-interface';

// ------------------------------------------------------------------
// FUTURE: Fork these types here to make this file fully standalone.
// ------------------------------------------------------------------
// export type RuntimeValue = number | boolean | string | number[] | { [key: string]: RuntimeValue } | RuntimeValue[];
// export interface RenderPipelineDef { ... }
// ------------------------------------------------------------------

/**
 * CPU JIT Compiler for WebGPU Host
 * Compiles IR Functions into flat JavaScript for high-performance execution.
 */
export class CpuJitCompiler {
  private ir?: IRDocument;

  compile(ir: IRDocument, entryPointId: string): Function {
    const body = this.compileToSource(ir, entryPointId);
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
      return new AsyncFunction('resources', 'inputs', 'globals', 'variables', body);
    } catch (e) {
      console.error("JIT Compilation Failed:\n", body);
      // Log the full body for debugging ReferenceErrors
      // (This will show up in the test output)
      throw e;
    }
  }

  compileToSource(ir: IRDocument, entryPointId: string): string {
    this.ir = ir;
    const allFunctions = ir.functions;
    const func = allFunctions.find((f: any) => f.id === entryPointId);
    if (!func) throw new Error(`Entry point '${entryPointId}' not found`);

    const lines: string[] = [];

    lines.push(`"use strict";`);
    lines.push(`// Compiled Graph starting at: ${func.id}`);
    const debugSync = !!ir.meta?.debug;
    if (debugSync) lines.push(`// DEBUG SYNC ENABLED`);

    const sanitizeId = (id: string, type: 'input' | 'var' | 'func' = 'var') => {
      const clean = id.replace(/[^a-zA-Z0-9_]/g, '_');
      if (type === 'input') return `i_${clean}`;
      if (type === 'func') return `func_${clean}`;
      return `v_${clean}`;
    };
    const nodeResId = (id: string) => `n_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const funcName = (id: string) => sanitizeId(id, 'func');

    // Add common helpers for vector/matrix math
    this.emitIntrinsicHelpers(lines);
    lines.push('');

    // 1. Collect all reachable CPU functions and check for cycles
    const reachable = new Set<string>();
    const stack = new Set<string>();
    const checkCycles = (fid: string) => {
      if (stack.has(fid)) throw new Error(`Recursion detected: ${fid}`);
      if (reachable.has(fid)) return;
      reachable.add(fid);
      stack.add(fid);
      const f = allFunctions.find((func: FunctionDef) => func.id === fid);
      if (f) {
        f.nodes.forEach((n: Node) => {
          if (n.op === 'call_func' && typeof n.func === 'string') {
            const target = allFunctions.find((tf: FunctionDef) => tf.id === n.func);
            if (target && target.type === 'cpu') checkCycles(n.func);
          }
        });
      }
      stack.delete(fid);
    };
    checkCycles(func.id);

    // 2. Emit each reachable function as a nested JS function
    for (const fid of reachable) {
      const f = allFunctions.find((func: any) => func.id === fid);
      if (f) {
        this.emitFunction(f, lines, sanitizeId, nodeResId, funcName, allFunctions, debugSync);
        lines.push('');
      }
    }

    // Map initial inputs to the entry function arguments
    lines.push('// Entry Point');
    lines.push('const entryInputs = {};');
    for (const input of func.inputs) {
      lines.push(`entryInputs['${input.id}'] = inputs.get('${input.id}');`);
    }
    lines.push(`return await ${funcName(func.id)}(entryInputs);`);

    return lines.join('\n');
  }

  private emitIntrinsicHelpers(lines: string[]) {
    lines.push(`// Intrinsics`);
    lines.push(`const _applyUnary = (v, f) => Array.isArray(v) ? v.map(f) : f(v);`);
    lines.push(`const _applyBinary = (a, b, f) => {
      if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => f(v, b[i]));
      if (Array.isArray(a)) return a.map(v => f(v, b));
      if (Array.isArray(b)) return b.map(v => f(a, v));
      return f(a, b);
    };`);
    lines.push(`const _vec_dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);`);
    lines.push(`const _vec_length = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));`);
    lines.push(`const _vec_normalize = (a) => { const l = _vec_length(a); return l < 1e-10 ? a.map(() => 0) : a.map(v => v / l); };`);
    lines.push(`const _mat_mul = (a, b) => {
      if (a.length === 16 || a.length === 9) {
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
      } else if (b.length === 16 || b.length === 9) {
        // Vector * Matrix (Row Vector)
        const dim = b.length === 16 ? 4 : 3;
        if (a.length === dim) {
          const out = new Array(dim).fill(0);
          for (let c = 0; c < dim; c++) {
            let sum = 0; for (let r = 0; r < dim; r++) sum += a[r] * b[c * dim + r];
            out[c] = sum;
          }
          return out;
        }
      }
      return 0;
    };`);
    lines.push(`const _quat_mul = (a, b) => {
      const [ax, ay, az, aw] = a;
      const [bx, by, bz, bw] = b;
      return [
        ax * bw + aw * bx + ay * bz - az * by,
        ay * bw + aw * by + az * bx - ax * bz,
        az * bw + aw * bz + ax * by - ay * bx,
        aw * bw - ax * bx - ay * by - az * bz
      ];
    };`);
    lines.push(`const _quat_slerp = (a, b, t) => {
      let ax = a[0], ay = a[1], az = a[2], aw = a[3];
      let bx = b[0], by = b[1], bz = b[2], bw = b[3];
      let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;
      if (Math.abs(cosHalfTheta) >= 1.0) return a;
      if (cosHalfTheta < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; cosHalfTheta = -cosHalfTheta; }
      const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);
      if (Math.abs(sinHalfTheta) < 0.001) return [(1 - t) * ax + t * bx, (1 - t) * ay + t * by, (1 - t) * az + t * bz, (1 - t) * aw + t * bw];
      const halfTheta = Math.acos(cosHalfTheta);
      const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
      const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
      return [ax * ratioA + bx * ratioB, ay * ratioA + by * ratioB, az * ratioA + bz * ratioB, aw * ratioA + bw * ratioB];
    };`);
    lines.push(`const _quat_to_mat4 = (q) => {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2;
      const yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      return [
        1 - (yy + zz), xy + wz, xz - wy, 0,
        xy - wz, 1 - (xx + zz), yz + wx, 0,
        xz + wy, yz - wx, 1 - (xx + yy), 0,
        0, 0, 0, 1
      ];
    };`);
    lines.push(`const _getVar = (id) => {
      if (variables.has(id)) return variables.get(id);
      if (inputs.has(id)) return inputs.get(id);
      throw new Error("Variable '" + id + "' is not defined");
    };`);
  }

  private emitFunction(f: FunctionDef, lines: string[], sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], debugSync: boolean) {
    lines.push(`async function ${funcName(f.id)}(args) {`);

    // Unpack args into local vars
    for (const input of f.inputs) {
      lines.push(`  let ${sanitizeId(input.id, 'input')} = args['${input.id}'];`);
    }

    // Local Variables
    for (const v of f.localVars) {
      const init = v.initialValue !== undefined ? JSON.stringify(v.initialValue) : '0';
      lines.push(`  let ${sanitizeId(v.id, 'var')} = ${init};`);
    }

    const edges = reconstructEdges(f);

    const resultNodes = f.nodes.filter(n => this.hasResult(n.op));
    for (const n of resultNodes) {
      lines.push(`  let ${nodeResId(n.id)};`);
    }

    const emittedPure = new Set<string>();
    const emitPure = (nodeId: string) => {
      if (emittedPure.has(nodeId)) return;
      const node = f.nodes.find(n => n.id === nodeId);
      if (!node || this.isExecutable(node.op)) return;

      // Mark as emitted to prevent recursion during dependency emission
      emittedPure.add(nodeId);

      // Emit data dependencies first
      edges.filter(e => e.to === nodeId && e.type === 'data').forEach(edge => {
        emitPure(edge.from);
      });

      lines.push(`  ${nodeResId(node.id)} = ${this.compileExpression(node, f, sanitizeId, nodeResId, funcName, allFunctions, true, emitPure, edges)};`);
    };

    // Compile node logic
    lines.push(`  // Pure Nodes (lazy emission)`);
    // We'll emit them as needed by the execution chain.
    // CRITICAL: We MUST ensure result variables are defined before any chain starts
    // because data dependencies can be circular or mixed.
    // (Already done in Local Variables section above via resultNodes filter)

    // Execution Chain
    const entryNodes = f.nodes.filter(n => {
      const hasExecIn = edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op);
    });

    for (const entry of entryNodes) {
      this.emitChain('  ', entry, f, lines, new Set(), sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    }

    // Sync variables back to Map if debug is enabled
    if (debugSync) {
      lines.push(`  if (variables) {`);
      for (const input of f.inputs) {
        lines.push(`    variables.set('${input.id}', ${sanitizeId(input.id, 'input')});`);
      }
      for (const v of f.localVars) {
        lines.push(`    variables.set('${v.id}', ${sanitizeId(v.id, 'var')});`);
      }
      lines.push(`  }`);
    }

    lines.push(`  return 0; // Default return`);
    lines.push(`}`);
  }

  private isExecutable(op: string) {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'texture_store' || op === 'call_func' || op === 'func_return' || op === 'array_set' ||
      op === 'cmd_resize_resource' || op === 'cmd_draw' || op === 'cmd_dispatch';
  }

  private hasResult(op: string) {
    if (op.startsWith('math_') || op.startsWith('vec_') || op.startsWith('mat_') || op.startsWith('quat_')) return true;
    const valueOps = [
      'float', 'int', 'uint', 'bool', 'literal', 'loop_index',
      'float2', 'float3', 'float4',
      'float3x3', 'float4x4',
      'mat_mul', 'mat_extract',
      'static_cast_float', 'static_cast_int', 'static_cast_uint', 'static_cast_bool',
      'struct_construct', 'struct_extract',
      'array_construct', 'array_extract', 'array_length', 'array_set',
      'var_get', 'buffer_load', 'texture_load', 'call_func', 'vec_swizzle',
      'color_mix', 'vec_get_element', 'quat',
      'resource_get_size', 'resource_get_format', 'builtin_get', 'const_get'
    ];
    return valueOps.includes(op);
  }

  private emitChain(indent: string, startNode: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], emitPure: (id: string) => void, edges: Edge[]) {
    let curr: Node | undefined = startNode;

    while (curr) {
      if (visited.has(curr.id)) {
        if (curr.op !== 'flow_loop') break;
      }
      visited.add(curr.id);

      // Ensure all data dependencies for this executable node are emitted
      edges.filter(e => e.to === curr!.id && e.type === 'data').forEach(e => emitPure(e.from));
      for (const k in curr) {
        if (['id', 'op', 'metadata', 'const_data', 'func', 'args', 'dispatch'].includes(k)) continue;
        const val = (curr as any)[k];
        if (typeof val === 'string' && func.nodes.some(n => n.id === val)) emitPure(val);
      }

      // If the node itself has a result (like call_func), ensure it's "emitted"
      // even if it's executable, so its variable is settled if used later.
      if (this.hasResult(curr.op)) {
        // For executable nodes that have results, we emit them directly in the chain
        this.emitNode(indent, curr, func, lines, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      } else if (curr.op === 'flow_branch') {
        this.emitBranch(indent, curr, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return;
      } else if (curr.op === 'flow_loop') {
        this.emitLoop(indent, curr, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return;
      } else if (curr.op === 'func_return') {
        lines.push(`${indent}return ${this.resolveArg(curr, 'val', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)};`);
        return;
      } else {
        this.emitNode(indent, curr, func, lines, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      }

      const outEdge = edges.find(e => e.from === curr!.id && e.portOut === 'exec_out' && e.type === 'execution');
      curr = outEdge ? func.nodes.find(n => n.id === outEdge.to) : undefined;
    }
  }

  private emitBranch(indent: string, node: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], emitPure: (id: string) => void, edges: Edge[]) {
    const cond = this.resolveArg(node, 'cond', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    lines.push(`${indent}if (${cond}) {`);
    const trueEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_true' && e.type === 'execution');
    const trueNode = trueEdge ? func.nodes.find(n => n.id === trueEdge.to) : undefined;
    if (trueNode) this.emitChain(indent + '  ', trueNode, func, lines, new Set(visited), sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    lines.push(`${indent}} else {`);
    const falseEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_false' && e.type === 'execution');
    const falseNode = falseEdge ? func.nodes.find(n => n.id === falseEdge.to) : undefined;
    if (falseNode) this.emitChain(indent + '  ', falseNode, func, lines, new Set(visited), sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    lines.push(`${indent}}`);
  }

  private emitLoop(indent: string, node: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], emitPure: (id: string) => void, edges: Edge[]) {
    const start = this.resolveArg(node, 'start', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    const end = this.resolveArg(node, 'end', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    const loopVar = `loop_${node.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    lines.push(`${indent}for (let ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);

    const bodyEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_body' && e.type === 'execution');
    const bodyNode = bodyEdge ? func.nodes.find(n => n.id === bodyEdge.to) : undefined;
    if (bodyNode) this.emitChain(indent + '  ', bodyNode, func, lines, new Set(visited), sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    lines.push(`${indent}}`);

    const compEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_completed' && e.type === 'execution');
    const nextNode = compEdge ? func.nodes.find(n => n.id === compEdge.to) : undefined;
    if (nextNode) this.emitChain(indent, nextNode, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
  }

  private emitNode(indent: string, node: Node, func: FunctionDef, lines: string[], sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], emitPure: (id: string) => void, edges: Edge[]) {
    if (node.op === 'cmd_dispatch') {
      const targetId = node['func'];
      let dimCode: string;
      if (Array.isArray(node['dispatch'])) {
        dimCode = JSON.stringify(node['dispatch']);
      } else {
        const dx = this.resolveArg(node, 'x', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const dy = this.resolveArg(node, 'y', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const dz = this.resolveArg(node, 'z', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        dimCode = `[${dx === '0' ? 1 : dx}, ${dy === '0' ? 1 : dy}, ${dz === '0' ? 1 : dz}]`;
      }
      lines.push(`${indent}await globals.dispatch('${targetId}', ${dimCode}, ${this.generateArgsObject(node, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)});`);
    }
    else if (node.op === 'call_func') {
      const targetId = node['func'];
      const targetFunc = allFunctions.find(f => f.id === targetId);
      if (targetFunc?.type === 'shader') {
        const dx = this.resolveArg(node, 'x', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const dy = this.resolveArg(node, 'y', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const dz = this.resolveArg(node, 'z', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const dimCode = `[${dx === '0' ? 1 : dx}, ${dy === '0' ? 1 : dy}, ${dz === '0' ? 1 : dz}]`;
        lines.push(`${indent}await globals.dispatch('${targetId}', ${dimCode}, ${this.generateArgsObject(node, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)});`);
      } else if (targetFunc) {
        lines.push(`${indent}${nodeResId(node.id)} = await ${funcName(targetId)}(${this.generateArgsObject(node, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)});`);
      }
    }
    else if (node.op === 'cmd_draw') {
      const target = node['target'];
      const vertex = node['vertex'];
      const fragment = node['fragment'];
      const count = this.resolveArg(node, 'count', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      const pipeline = JSON.stringify(node['pipeline'] || {});
      lines.push(`${indent}await globals.draw('${target}', '${vertex}', '${fragment}', ${count}, ${pipeline});`);
    }
    else if (node.op === 'cmd_resize_resource') {
      const resId = node['resource'];
      const size = this.resolveArg(node, 'size', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      const resolveRaw = (key: string) => {
        const edge = edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
        if (edge || node[key] !== undefined) return this.resolveArg(node, key, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return 'undefined';
      };
      lines.push(`${indent}globals.resize('${resId}', ${size}, ${resolveRaw('format')}, ${resolveRaw('clear')});`);
    }
    else if (node.op === 'var_set') {
      const val = this.resolveArg(node, 'val', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      const varId = node['var'];
      if (func.localVars.some(v => v.id === varId)) lines.push(`${indent}${sanitizeId(varId, 'var')} = ${val};`);
      else if (func.inputs.some(i => i.id === varId)) lines.push(`${indent}${sanitizeId(varId, 'input')} = ${val};`);
      else lines.push(`${indent}variables.set('${varId}', ${val});`);
    }
    else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'];
      const idx = this.resolveArg(node, 'index', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      const val = this.resolveArg(node, 'value', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      lines.push(`${indent}resources.get('${bufferId}').data[${idx}] = ${val};`);
    }
    else if (node.op === 'texture_store') {
      const texId = node['tex'];
      const coords = this.resolveArg(node, 'coords', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      const val = this.resolveArg(node, 'value', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      lines.push(`${indent}((coords, val) => {
        const res = resources.get('${texId}');
        if (!res) return;
        const x = Math.floor(coords[0]), y = Math.floor(coords[1]);
        if (x >= 0 && x < res.width && y >= 0 && y < res.height) res.data[y * res.width + x] = val;
      })(${coords}, ${val});`);
    }
    else if (this.hasResult(node.op)) {
      lines.push(`${indent}${nodeResId(node.id)} = ${this.compileExpression(node, func, sanitizeId, nodeResId, funcName, allFunctions, true, emitPure, edges)};`);
    }
  }

  private resolveArg(node: Node, key: string, func: FunctionDef, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], emitPure: (id: string) => void, edges: Edge[]): string {
    const edge = edges.find(e => e.to === node.id && (e.portIn === key || (key === 'val' && e.portIn === 'value')) && e.type === 'data');
    if (edge) {
      const source = func.nodes.find(n => n.id === edge.from);
      if (source) return this.compileExpression(source, func, sanitizeId, nodeResId, funcName, allFunctions, false, emitPure, edges);
    }

    let val: any = undefined;
    if (node[key] !== undefined || (key === 'val' && node['value'] !== undefined)) {
      val = (node[key] !== undefined) ? node[key] : node['value'];
    } else {
      const match = key.match(/^(.+)\[(\d+)\]$/);
      if (match) {
        const baseKey = match[1];
        const idx = parseInt(match[2], 10);
        if (Array.isArray(node[baseKey])) val = node[baseKey][idx];
      }
    }

    if (val !== undefined) {
      if (typeof val === 'string' && !['var', 'func', 'resource', 'buffer'].includes(key)) {
        if (func.localVars.some(v => v.id === val)) return sanitizeId(val, 'var');
        if (func.inputs.some(i => i.id === val)) return sanitizeId(val, 'input');
        if (this.ir?.inputs.some((i: any) => i.id === val)) return `inputs.get('${val}')`;
        const targetNode = func.nodes.find(n => n.id === val);
        if (targetNode && targetNode.id !== node.id) return this.compileExpression(targetNode, func, sanitizeId, nodeResId, funcName, allFunctions, false, emitPure, edges);
      }
      return JSON.stringify(val);
    }
    return '0';
  }

  private compileExpression(node: Node, func: FunctionDef, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], forceEmit: boolean = false, emitPure: (id: string) => void, edges: Edge[]): string {
    if (!forceEmit && this.hasResult(node.op)) {
      emitPure(node.id);
      return nodeResId(node.id);
    }

    const a = (k = 'a') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    const b = (k = 'b') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    const val = (k = 'val') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);

    switch (node.op) {
      case 'var_get': {
        const varId = node['var'];
        if (func.localVars.some(v => v.id === varId)) return sanitizeId(varId, 'var');
        if (func.inputs.some(i => i.id === varId)) return sanitizeId(varId, 'input');
        return `_getVar('${varId}')`;
      }
      case 'literal': return JSON.stringify(node['val']);
      case 'loop_index': return `loop_${node['loop'].replace(/[^a-zA-Z0-9_]/g, '_')}`;
      case 'buffer_load': {
        const bufferId = node['buffer'];
        const idx = a('index');
        return `((idx) => {
          const res = resources.get('${bufferId}');
          if (!res) return 0;
          if (idx < 0 || idx >= res.data.length) throw new Error("Runtime Error: buffer_load OOB");
          return res.data[idx];
        })(${idx})`;
      }
      case 'texture_load': {
        const texId = node['tex'];
        const coords = this.resolveArg(node, 'coords', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `((coords) => {
          const res = resources.get('${texId}');
          if (!res) return [0, 0, 0, 0];
          const x = Math.floor(coords[0]), y = Math.floor(coords[1]);
          if (x < 0 || x >= res.width || y < 0 || y >= res.height) return [0, 0, 0, 0];
          return res.data[y * res.width + x] || [0, 0, 0, 0];
        })(${coords})`;
      }
      case 'texture_sample': {
        const texId = node['tex'];
        const uv = (node['uv'] !== undefined) ? this.resolveArg(node, 'uv', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges) : this.resolveArg(node, 'coords', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `((uv) => {
          const res = resources.get('${texId}');
          if (!res) return [0, 0, 0, 0];
          const wrap = res.def.sampler?.wrap || 'clamp';
          let u = uv[0], v = uv[1];
          if (wrap === 'repeat') { u -= Math.floor(u); v -= Math.floor(v); }
          else if (wrap === 'mirror') {
            const u2 = u - 2.0 * Math.floor(u * 0.5); u = 1.0 - Math.abs(u2 - 1.0);
            const v2 = v - 2.0 * Math.floor(v * 0.5); v = 1.0 - Math.abs(v2 - 1.0);
          }
          else { u = Math.max(0, Math.min(1, u)); v = Math.max(0, Math.min(1, v)); }
          const x = Math.min(res.width - 1, Math.floor(u * res.width));
          const y = Math.min(res.height - 1, Math.floor(v * res.height));
          return res.data[y * res.width + x] || [0, 0, 0, 0];
        })(${uv})`;
      }
      case 'resource_get_size': {
        const resId = node['resource'];
        return `((id) => {
          const res = resources.get(id);
          if (!res) return [0, 0];
          return res.def.type === 'texture2d' ? [res.width, res.height] : [res.width, 0];
        })('${resId}')`;
      }
      case 'resource_get_format': {
        const resId = node['resource'];
        return `((id) => {
          const res = resources.get(id);
          return res ? (res.def.format || 'rgba8') : 'rgba8';
        })('${resId}')`;
      }

      // Basic Math (Unary)
      case 'math_neg': return `_applyUnary(${val()}, v => -v)`;
      case 'math_abs': return `_applyUnary(${val()}, Math.abs)`;
      case 'math_sign': return `_applyUnary(${val()}, Math.sign)`;
      case 'math_sin': return `_applyUnary(${val()}, Math.sin)`;
      case 'math_cos': return `_applyUnary(${val()}, Math.cos)`;
      case 'math_tan': return `_applyUnary(${val()}, Math.tan)`;
      case 'math_asin': return `_applyUnary(${val()}, Math.asin)`;
      case 'math_acos': return `_applyUnary(${val()}, Math.acos)`;
      case 'math_atan': return `_applyUnary(${val()}, Math.atan)`;
      case 'math_sinh': return `_applyUnary(${val()}, Math.sinh)`;
      case 'math_cosh': return `_applyUnary(${val()}, Math.cosh)`;
      case 'math_tanh': return `_applyUnary(${val()}, Math.tanh)`;
      case 'math_sqrt': return `_applyUnary(${val()}, Math.sqrt)`;
      case 'math_exp': return `_applyUnary(${val()}, Math.exp)`;
      case 'math_log': return `_applyUnary(${val()}, Math.log)`;
      case 'math_ceil': return `_applyUnary(${val()}, Math.ceil)`;
      case 'math_floor': return `_applyUnary(${val()}, Math.floor)`;
      case 'math_trunc': return `_applyUnary(${val()}, Math.trunc)`;
      case 'math_fract': return `_applyUnary(${val()}, v => v - Math.floor(v))`;
      case 'math_is_nan': return `_applyUnary(${val()}, v => isNaN(v) ? 1.0 : 0.0)`;
      case 'math_is_inf': return `_applyUnary(${val()}, v => (!isFinite(v) && !isNaN(v)) ? 1.0 : 0.0)`;
      case 'math_is_finite': return `_applyUnary(${val()}, v => isFinite(v) ? 1.0 : 0.0)`;
      case 'math_flush_subnormal': return `_applyUnary(${val()}, v => Math.abs(v) < 1.17549435e-38 ? 0.0 : v)`;
      case 'math_mantissa': return `_applyUnary(${val()}, v => {
        if (v === 0 || !isFinite(v)) return v;
        const exp = Math.floor(Math.log2(Math.abs(v))) + 1;
        return v * Math.pow(2, -exp);
      })`;
      case 'math_exponent': return `_applyUnary(${val()}, v => {
        if (v === 0 || !isFinite(v)) return 0;
        return Math.floor(Math.log2(Math.abs(v))) + 1;
      })`;

      // Basic Math (Binary)
      case 'math_add': return `_applyBinary(${a()}, ${b()}, (x, y) => x + y)`;
      case 'math_sub': return `_applyBinary(${a()}, ${b()}, (x, y) => x - y)`;
      case 'math_mul': return `_applyBinary(${a()}, ${b()}, (x, y) => x * y)`;
      case 'math_div': return `_applyBinary(${a()}, ${b()}, (x, y) => x / y)`;
      case 'math_mod': return `_applyBinary(${a()}, ${b()}, (x, y) => x % y)`;
      case 'math_pow': return `_applyBinary(${a()}, ${b()}, Math.pow)`;
      case 'math_min': return `_applyBinary(${a()}, ${b()}, Math.min)`;
      case 'math_max': return `_applyBinary(${a()}, ${b()}, Math.max)`;
      case 'math_atan2': return `_applyBinary(${a()}, ${b()}, Math.atan2)`;
      case 'math_clamp': {
        const minVal = this.resolveArg(node, 'min', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const maxVal = this.resolveArg(node, 'max', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `((v, min, max) => _applyBinary(_applyBinary(v, min, Math.max), max, Math.min))(${val()}, ${minVal}, ${maxVal})`;
      }
      case 'math_mad': {
        const cVal = this.resolveArg(node, 'c', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `_applyBinary(_applyBinary(${a()}, ${b()}, (x, y) => x * y), ${cVal}, (x, y) => x + y)`;
      }

      case 'math_mix': {
        const t = this.resolveArg(node, 't', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `((a, b, t) => _applyBinary(_applyBinary(a, _applyBinary(1, t, (x, y) => x - y), (x, y) => x * y), _applyBinary(b, t, (x, y) => x * y), (x, y) => x + y))(${a()}, ${b()}, ${t})`;
      }
      case 'math_step': return `_applyBinary(${this.resolveArg(node, 'edge', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}, ${val()}, (e, x) => x < e ? 0 : 1)`;
      case 'math_smoothstep': {
        const e0 = this.resolveArg(node, 'edge0', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const e1 = this.resolveArg(node, 'edge1', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `((v, edge0, edge1) => _applyUnary(_applyBinary(_applyBinary(v, edge0, (x, e) => (x - e)), _applyBinary(edge1, edge0, (e1, e0) => (e1 - e0)), (n, d) => Math.max(0, Math.min(1, n / d))), t => t * t * (3 - 2 * t)))(${val()}, ${e0}, ${e1})`;
      }

      // Matrix
      case 'mat_identity': {
        const size = Number(node['size'] || 4);
        const arr = new Array(size * size).fill(0);
        for (let i = 0; i < size; i++) arr[i * size + i] = 1;
        return JSON.stringify(arr);
      }
      case 'mat_mul': return `_mat_mul(${a()}, ${b()})`;
      case 'mat_extract': return `(${a()}[${b('index')}])`;
      case 'mat_transpose': {
        const m = a();
        return `((m) => {
          const dim = Math.sqrt(m.length);
          const out = new Array(m.length);
          for(let r=0; r<dim; r++) for(let c=0; c<dim; c++) out[c*dim + r] = m[r*dim + c];
          return out;
        })(${m})`;
      }

      // Color
      case 'color_mix': {
        const dst = a();
        const src = b();
        const tEdge = edges.find(e => e.to === node.id && e.portIn === 't' && e.type === 'data');
        if (tEdge || (node['t'] !== undefined)) {
          const t = this.resolveArg(node, 't', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
          return `_applyBinary(_applyBinary(${dst}, _applyBinary(1, ${t}, (x, y) => x - y), (x, y) => x * y), _applyBinary(${src}, ${t}, (x, y) => x * y), (x, y) => x + y)`;
        }
        return `((d, s) => {
          if (!Array.isArray(s) || !Array.isArray(d)) return s;
          const out = new Array(4);
          const sa = s[3] === undefined ? 1.0 : s[3];
          const da = d[3] === undefined ? 1.0 : d[3];
          const ra = sa + da * (1 - sa);
          for(let i=0; i<3; i++) out[i] = ra < 1e-6 ? 0 : (s[i]*sa + d[i]*da*(1-sa))/ra;
          out[3] = ra;
          return out;
        })(${dst}, ${src})`;
      }

      // Vectors / Arrays
      case 'vec_get_element': return `(${this.resolveArg(node, 'vec', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}[${this.resolveArg(node, 'index', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}])`;
      case 'vec_mix': {
        const t = this.resolveArg(node, 't', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `((a, b, t) => _applyBinary(_applyBinary(a, _applyBinary(1, t, (x, y) => x - y), (x, y) => x * y), _applyBinary(b, t, (x, y) => x * y), (x, y) => x + y))(${a()}, ${b()}, ${t})`;
      }

      // Constants
      case 'math_pi': return `Math.PI`;
      case 'math_e': return `Math.E`;

      // Comparison
      case 'math_gt': return `_applyBinary(${a()}, ${b()}, (x, y) => x > y ? 1.0 : 0.0)`;
      case 'math_lt': return `_applyBinary(${a()}, ${b()}, (x, y) => x < y ? 1.0 : 0.0)`;
      case 'math_ge': return `_applyBinary(${a()}, ${b()}, (x, y) => x >= y ? 1.0 : 0.0)`;
      case 'math_le': return `_applyBinary(${a()}, ${b()}, (x, y) => x <= y ? 1.0 : 0.0)`;
      case 'math_eq': return `_applyBinary(${a()}, ${b()}, (x, y) => x === y ? 1.0 : 0.0)`;
      case 'math_neq': return `_applyBinary(${a()}, ${b()}, (x, y) => x !== y ? 1.0 : 0.0)`;

      // Logic
      case 'math_and': return `_applyBinary(${a()}, ${b()}, (x, y) => (x && y) ? 1.0 : 0.0)`;
      case 'math_or': return `_applyBinary(${a()}, ${b()}, (x, y) => (x || y) ? 1.0 : 0.0)`;
      case 'math_xor': return `_applyBinary(${a()}, ${b()}, (x, y) => (x ^ y) ? 1.0 : 0.0)`;
      case 'math_not': return `_applyUnary(${val()}, v => (!v) ? 1.0 : 0.0)`;

      // Casts
      case 'float': return `Number(${val()})`;
      case 'int': return `Math.trunc(${val()})`;
      case 'bool': return `Boolean(${val()})`;
      case 'static_cast_float': return `Number(${val()})`;
      case 'static_cast_int': return `(${val()} | 0)`;
      case 'mat_inverse': return a('val');
      case 'static_cast_uint': return `Math.abs(Math.trunc(${val()}))`; // Simplification for Uint
      case 'static_cast_bool': return `Boolean(${val()})`;

      // Vectors
      case 'float2': return `[${a('x')}, ${a('y')}]`;
      case 'float3': return `[${a('x')}, ${a('y')}, ${a('z')}]`;
      case 'float4': return `[${a('x')}, ${a('y')}, ${a('z')}, ${a('w')}]`;
      case 'float3x3':
      case 'float4x4': {
        const size = node.op === 'float3x3' ? 9 : 16;
        if (node['vals'] !== undefined || edges.some(e => e.to === node.id && e.portIn === 'vals')) {
          return a('vals');
        }
        const keys = size === 9 ? ['m00', 'm10', 'm20', 'm01', 'm11', 'm21', 'm02', 'm12', 'm22'] :
          ['m00', 'm10', 'm20', 'm30', 'm01', 'm11', 'm21', 'm31', 'm02', 'm12', 'm22', 'm32', 'm03', 'm13', 'm23', 'm33'];
        return `[${keys.map(k => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)).join(', ')}]`;
      }
      case 'vec_dot': return `_vec_dot(${a()}, ${b()})`;
      case 'vec_length': return `_vec_length(${a()})`;
      case 'vec_normalize': return `_vec_normalize(${a()})`;
      case 'vec_swizzle': {
        const vec = this.resolveArg(node, 'vec', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
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
          parts.push(`'${k}': ${this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}`);
        }
        return `{ ${parts.join(', ')} }`;
      }
      case 'struct_extract': return `(${this.resolveArg(node, 'struct', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}['${node['field'] || node['member']}'])`;

      // Arrays
      case 'array_construct': {
        const values = node['values'];
        if (Array.isArray(values)) {
          const items = values.map((_, i) => this.resolveArg(node, `values[${i}]`, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges));
          return `[${items.join(', ')}]`;
        }
        const len = this.resolveArg(node, 'length', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const fill = this.resolveArg(node, 'fill', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `new Array(${len}).fill(${fill})`;
      }
      case 'array_extract': return `${this.resolveArg(node, 'array', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}[${a('index')}]`;
      case 'array_length': return `(${this.resolveArg(node, 'array', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}.length)`;
      case 'array_set': return `(${this.resolveArg(node, 'array', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}[${a('index')}] = ${val('value')})`;

      // Quaternions
      case 'quat': return `[${a('x')}, ${a('y')}, ${a('z')}, ${a('w')}]`;
      case 'quat_identity': return `[0, 0, 0, 1]`;
      case 'quat_mul': return `_quat_mul(${a()}, ${b()})`;
      case 'quat_rotate': {
        const v = a('v');
        const q = a('q');
        return `((v, q) => {
          const [vx, vy, vz] = v;
          const [qx, qy, qz, qw] = q;
          const ix = qw * vx + qy * vz - qz * vy;
          const iy = qw * vy + qz * vx - qx * vz;
          const iz = qw * vz + qx * vy - qy * vx;
          const iw = -qx * vx - qy * vy - qz * vz;
          return [
            ix * qw + iw * -qx + iy * -qz - iz * -qy,
            iy * qw + iw * -qy + iz * -qx - ix * -qz,
            iz * qw + iw * -qz + ix * -qy - iy * -qx
          ];
        })(${v}, ${q})`;
      }
      case 'quat_slerp': return `_quat_slerp(${a()}, ${b()}, ${this.resolveArg(node, 't', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)})`;
      case 'quat_to_float4x4': return `_quat_to_mat4(${this.resolveArg(node, 'q', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)})`;

      default: return '0';
    }
  }

  private generateArgsObject(node: Node, func: FunctionDef, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], emitPure: (id: string) => void, edges: Edge[]): string {
    const parts: string[] = [];
    const targetId = node['func'];
    const targetFunc = allFunctions.find(f => f.id === targetId);

    if (targetFunc) {
      targetFunc.inputs.forEach((input, idx) => {
        let valExpr = '0';
        if (node['args'] && node['args'][idx] !== undefined) valExpr = JSON.stringify(node['args'][idx]);
        else valExpr = this.resolveArg(node, input.id, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        parts.push(`'${input.id}': ${valExpr}`);
      });
    } else {
      for (const k in node) {
        if (['id', 'op', 'metadata', 'const_data', 'func', 'args', 'dispatch'].includes(k)) continue;
        parts.push(`'${k}': ${this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}`);
      }
    }
    return `{ ${parts.join(', ')} }`;
  }
}
