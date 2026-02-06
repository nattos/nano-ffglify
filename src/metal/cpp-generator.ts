/**
 * C++ Code Generator for IR execution
 * Generates standalone C++ code from IR, modeled after cpu-jit.ts
 */

import { IRDocument, FunctionDef, Node, Edge } from '../ir/types';
import { reconstructEdges } from '../ir/utils';

export interface CppCompileResult {
  code: string;
  resourceIds: string[];
}

/**
 * C++ Code Generator
 * Compiles IR functions to standalone C++ code for CPU execution
 */
export class CppGenerator {
  private ir?: IRDocument;

  /**
   * Compile an IR document to C++ source code
   */
  compile(ir: IRDocument, entryPointId: string): CppCompileResult {
    this.ir = ir;
    const allFunctions = ir.functions;
    const func = allFunctions.find((f: FunctionDef) => f.id === entryPointId);
    if (!func) throw new Error(`Entry point '${entryPointId}' not found`);

    const lines: string[] = [];

    // Note: We don't emit headers or intrinsic helpers - the harness provides them
    lines.push('// Generated C++ code from IR');
    lines.push('// Entry point: ' + func.id);
    lines.push('');

    // Collect resource IDs for the harness
    const resourceIds = ir.resources.map(r => r.id);

    // Emit function
    this.emitFunction(func, lines, allFunctions);

    return {
      code: lines.join('\n'),
      resourceIds,
    };
  }

  /**
   * Format a number as a C++ float literal
   */
  private formatFloat(n: number): string {
    // Ensure we have a decimal point for float literals
    const s = String(n);
    if (s.includes('.') || s.includes('e') || s.includes('E')) {
      return s + 'f';
    }
    return s + '.0f';
  }

  private sanitizeId(id: string, type: 'input' | 'var' | 'func' = 'var'): string {
    const clean = id.replace(/[^a-zA-Z0-9_]/g, '_');
    if (type === 'input') return `i_${clean}`;
    if (type === 'func') return `func_${clean}`;
    return `v_${clean}`;
  }

  private nodeResId(id: string): string {
    return `n_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  private emitFunction(f: FunctionDef, lines: string[], allFunctions: FunctionDef[]) {
    lines.push(`void ${this.sanitizeId(f.id, 'func')}(EvalContext& ctx) {`);

    // Declare local variables
    for (const v of f.localVars) {
      const init = v.initialValue !== undefined ? String(v.initialValue) : '0.0f';
      lines.push(`    float ${this.sanitizeId(v.id, 'var')} = ${init};`);
    }

    const edges = reconstructEdges(f);


    // Track which pure nodes have been emitted (for auto declarations)
    const emittedPure = new Set<string>();
    const emitPure = (nodeId: string) => {
      if (emittedPure.has(nodeId)) return;
      const node = f.nodes.find(n => n.id === nodeId);
      if (!node || this.isExecutable(node.op)) return;

      emittedPure.add(nodeId);

      // Emit dependencies first
      edges.filter(e => e.to === nodeId && e.type === 'data').forEach(edge => {
        emitPure(edge.from);
      });

      // Use auto with inline initialization
      const expr = this.compileExpression(node, f, allFunctions, true, emitPure, edges);
      lines.push(`    auto ${this.nodeResId(node.id)} = ${expr};`);
    };

    // Find entry nodes (executable nodes with no incoming execution edges)
    const entryNodes = f.nodes.filter(n => {
      const hasExecIn = edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op);
    });

    for (const entry of entryNodes) {
      this.emitChain('    ', entry, f, lines, new Set(), allFunctions, emitPure, edges);
    }

    lines.push('}');
  }

  private hasResult(op: string): boolean {
    const valueOps = [
      'float', 'int', 'uint', 'bool', 'literal', 'loop_index',
      'float2', 'float3', 'float4',
      'static_cast_float', 'static_cast_int',
      'var_get', 'buffer_load', 'vec_swizzle',
      'vec_get_element',
    ];
    return valueOps.includes(op) || op.startsWith('math_') || op.startsWith('vec_');
  }

  private isExecutable(op: string): boolean {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'func_return';
  }

  private inferCppType(node: Node): string {
    // Use 'auto' for most nodes - let C++ type deduction handle it
    // This avoids needing to track types through the expression tree
    switch (node.op) {
      // Explicit types for known constructors
      case 'float2':
        return 'std::array<float, 2>';
      case 'float3':
        return 'std::array<float, 3>';
      case 'float4':
        return 'std::array<float, 4>';
      // vec_normalize preserves input dimension - use auto
      // Default to auto for type inference
      default:
        return 'auto';
    }
  }

  private emitChain(
    indent: string,
    startNode: Node,
    func: FunctionDef,
    lines: string[],
    visited: Set<string>,
    allFunctions: FunctionDef[],
    emitPure: (id: string) => void,
    edges: Edge[]
  ) {
    let curr: Node | undefined = startNode;

    while (curr) {
      if (visited.has(curr.id)) break;
      visited.add(curr.id);

      // Emit data dependencies
      edges.filter(e => e.to === curr!.id && e.type === 'data').forEach(e => emitPure(e.from));
      for (const k in curr) {
        if (['id', 'op', 'metadata'].includes(k)) continue;
        const val = (curr as any)[k];
        if (typeof val === 'string' && func.nodes.some(n => n.id === val)) emitPure(val);
      }

      if (curr.op === 'flow_branch') {
        this.emitBranch(indent, curr, func, lines, visited, allFunctions, emitPure, edges);
        return;
      } else if (curr.op === 'flow_loop') {
        this.emitLoop(indent, curr, func, lines, visited, allFunctions, emitPure, edges);
        return;
      } else if (curr.op === 'func_return') {
        lines.push(`${indent}return;`);
        return;
      } else {
        this.emitNode(indent, curr, func, lines, allFunctions, emitPure, edges);
      }

      const outEdge = edges.find(e => e.from === curr!.id && e.portOut === 'exec_out' && e.type === 'execution');
      curr = outEdge ? func.nodes.find(n => n.id === outEdge.to) : undefined;
    }
  }

  private emitBranch(
    indent: string,
    node: Node,
    func: FunctionDef,
    lines: string[],
    visited: Set<string>,
    allFunctions: FunctionDef[],
    emitPure: (id: string) => void,
    edges: Edge[]
  ) {
    const cond = this.resolveArg(node, 'cond', func, allFunctions, emitPure, edges);
    lines.push(`${indent}if (${cond}) {`);
    const trueEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_true' && e.type === 'execution');
    const trueNode = trueEdge ? func.nodes.find(n => n.id === trueEdge.to) : undefined;
    if (trueNode) this.emitChain(indent + '    ', trueNode, func, lines, new Set(visited), allFunctions, emitPure, edges);
    lines.push(`${indent}} else {`);
    const falseEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_false' && e.type === 'execution');
    const falseNode = falseEdge ? func.nodes.find(n => n.id === falseEdge.to) : undefined;
    if (falseNode) this.emitChain(indent + '    ', falseNode, func, lines, new Set(visited), allFunctions, emitPure, edges);
    lines.push(`${indent}}`);
  }

  private emitLoop(
    indent: string,
    node: Node,
    func: FunctionDef,
    lines: string[],
    visited: Set<string>,
    allFunctions: FunctionDef[],
    emitPure: (id: string) => void,
    edges: Edge[]
  ) {
    const start = this.resolveArg(node, 'start', func, allFunctions, emitPure, edges);
    const end = this.resolveArg(node, 'end', func, allFunctions, emitPure, edges);
    const loopVar = `loop_${node.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    lines.push(`${indent}for (int ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);

    const bodyEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_body' && e.type === 'execution');
    const bodyNode = bodyEdge ? func.nodes.find(n => n.id === bodyEdge.to) : undefined;
    if (bodyNode) this.emitChain(indent + '    ', bodyNode, func, lines, new Set(visited), allFunctions, emitPure, edges);
    lines.push(`${indent}}`);

    const compEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_completed' && e.type === 'execution');
    const nextNode = compEdge ? func.nodes.find(n => n.id === compEdge.to) : undefined;
    if (nextNode) this.emitChain(indent, nextNode, func, lines, visited, allFunctions, emitPure, edges);
  }

  private emitNode(
    indent: string,
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    emitPure: (id: string) => void,
    edges: Edge[]
  ) {
    if (node.op === 'var_set') {
      const val = this.resolveArg(node, 'val', func, allFunctions, emitPure, edges);
      const varId = node['var'];
      lines.push(`${indent}${this.sanitizeId(varId, 'var')} = ${val};`);
    } else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'];
      const idx = this.resolveArg(node, 'index', func, allFunctions, emitPure, edges);
      const val = this.resolveArg(node, 'value', func, allFunctions, emitPure, edges);
      // Find buffer index in resources
      const bufferIdx = this.ir?.resources.findIndex(r => r.id === bufferId) ?? -1;
      lines.push(`${indent}ctx.resources[${bufferIdx}]->data[static_cast<size_t>(${idx})] = ${val};`);
    } else if (this.hasResult(node.op)) {
      const expr = this.compileExpression(node, func, allFunctions, true, emitPure, edges);
      lines.push(`${indent}${this.nodeResId(node.id)} = ${expr};`);
    }
  }

  private resolveArg(
    node: Node,
    key: string,
    func: FunctionDef,
    allFunctions: FunctionDef[],
    emitPure: (id: string) => void,
    edges: Edge[]
  ): string {
    const edge = edges.find(e => e.to === node.id && (e.portIn === key || (key === 'val' && e.portIn === 'value')) && e.type === 'data');
    if (edge) {
      const source = func.nodes.find(n => n.id === edge.from);
      if (source) return this.compileExpression(source, func, allFunctions, false, emitPure, edges);
    }

    let val: any = node[key];

    if (val !== undefined) {
      if (typeof val === 'string') {
        if (func.localVars.some(v => v.id === val)) return this.sanitizeId(val, 'var');
        if (func.inputs.some(i => i.id === val)) return this.sanitizeId(val, 'input');
        const targetNode = func.nodes.find(n => n.id === val);
        if (targetNode && targetNode.id !== node.id) {
          return this.compileExpression(targetNode, func, allFunctions, false, emitPure, edges);
        }
      }
      if (typeof val === 'number') return this.formatFloat(val);
      if (typeof val === 'boolean') return val ? '1.0f' : '0.0f';
      if (Array.isArray(val)) {
        const items = val.map(v => typeof v === 'number' ? this.formatFloat(v) : String(v));
        return `std::array<float, ${val.length}>{${items.join(', ')}}`;
      }
      return String(val);
    }
    return '0.0f';
  }

  private compileExpression(
    node: Node,
    func: FunctionDef,
    allFunctions: FunctionDef[],
    forceEmit: boolean,
    emitPure: (id: string) => void,
    edges: Edge[]
  ): string {
    if (!forceEmit && this.hasResult(node.op)) {
      emitPure(node.id);
      return this.nodeResId(node.id);
    }

    const a = (k = 'a') => this.resolveArg(node, k, func, allFunctions, emitPure, edges);
    const b = (k = 'b') => this.resolveArg(node, k, func, allFunctions, emitPure, edges);
    const val = (k = 'val') => this.resolveArg(node, k, func, allFunctions, emitPure, edges);

    switch (node.op) {
      case 'var_get': {
        const varId = node['var'];
        if (func.localVars.some(v => v.id === varId)) return this.sanitizeId(varId, 'var');
        if (func.inputs.some(i => i.id === varId)) return this.sanitizeId(varId, 'input');
        throw new Error(`C++ Generator: Variable '${varId}' not found`);
      }
      case 'literal': {
        const v = node['val'];
        if (typeof v === 'number') return this.formatFloat(v);
        if (typeof v === 'boolean') return v ? '1.0f' : '0.0f';
        if (Array.isArray(v)) {
          const items = v.map(x => typeof x === 'number' ? this.formatFloat(x) : String(x));
          return `std::array<float, ${v.length}>{${items.join(', ')}}`;
        }
        return String(v);
      }
      case 'loop_index':
        return `static_cast<float>(loop_${node['loop'].replace(/[^a-zA-Z0-9_]/g, '_')})`;

      case 'buffer_load': {
        const bufferId = node['buffer'];
        const idx = a('index');
        const bufferIdx = this.ir?.resources.findIndex(r => r.id === bufferId) ?? -1;
        return `ctx.resources[${bufferIdx}]->data[static_cast<size_t>(${idx})]`;
      }

      // Math ops
      case 'math_neg': return `applyUnary(${val()}, [](float v) { return -v; })`;
      case 'math_abs': return `applyUnary(${val()}, [](float v) { return std::abs(v); })`;
      case 'math_sign': return `applyUnary(${val()}, [](float v) { return v > 0 ? 1.0f : (v < 0 ? -1.0f : 0.0f); })`;
      case 'math_sin': return `applyUnary(${val()}, [](float v) { return std::sin(v); })`;
      case 'math_cos': return `applyUnary(${val()}, [](float v) { return std::cos(v); })`;
      case 'math_tan': return `applyUnary(${val()}, [](float v) { return std::tan(v); })`;
      case 'math_asin': return `applyUnary(${val()}, [](float v) { return std::asin(v); })`;
      case 'math_acos': return `applyUnary(${val()}, [](float v) { return std::acos(v); })`;
      case 'math_atan': return `applyUnary(${val()}, [](float v) { return std::atan(v); })`;
      case 'math_sqrt': return `applyUnary(${val()}, [](float v) { return std::sqrt(v); })`;
      case 'math_exp': return `applyUnary(${val()}, [](float v) { return std::exp(v); })`;
      case 'math_log': return `applyUnary(${val()}, [](float v) { return std::log(v); })`;
      case 'math_ceil': return `applyUnary(${val()}, [](float v) { return std::ceil(v); })`;
      case 'math_floor': return `applyUnary(${val()}, [](float v) { return std::floor(v); })`;
      case 'math_trunc': return `applyUnary(${val()}, [](float v) { return std::trunc(v); })`;
      case 'math_fract': return `applyUnary(${val()}, [](float v) { return v - std::floor(v); })`;

      case 'math_add': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x + y; })`;
      case 'math_sub': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x - y; })`;
      case 'math_mul': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x * y; })`;
      case 'math_div': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x / y; })`;
      case 'math_mod': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return std::fmod(x, y); })`;
      case 'math_pow': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return std::pow(x, y); })`;
      case 'math_min': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return std::min(x, y); })`;
      case 'math_max': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return std::max(x, y); })`;
      case 'math_atan2': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return std::atan2(x, y); })`;

      case 'math_gt': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x > y ? 1.0f : 0.0f; })`;
      case 'math_lt': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x < y ? 1.0f : 0.0f; })`;
      case 'math_ge': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x >= y ? 1.0f : 0.0f; })`;
      case 'math_le': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x <= y ? 1.0f : 0.0f; })`;
      case 'math_eq': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x == y ? 1.0f : 0.0f; })`;
      case 'math_neq': return `applyBinary(${a()}, ${b()}, [](float x, float y) { return x != y ? 1.0f : 0.0f; })`;

      case 'float': return `static_cast<float>(${val()})`;
      case 'static_cast_float': return `static_cast<float>(${val()})`;

      case 'float2': return `std::array<float, 2>{${a('x')}, ${a('y')}}`;
      case 'float3': return `std::array<float, 3>{${a('x')}, ${a('y')}, ${a('z')}}`;
      case 'float4': return `std::array<float, 4>{${a('x')}, ${a('y')}, ${a('z')}, ${a('w')}}`;

      case 'vec_dot': return `vec_dot(${a()}, ${b()})`;
      case 'vec_length': return `vec_length(${a()})`;
      case 'vec_normalize': return `vec_normalize(${a()})`;

      case 'vec_swizzle': {
        const vec = this.resolveArg(node, 'vec', func, allFunctions, emitPure, edges);
        const channels = node['channels'] || node['swizzle'] || 'x';
        const map: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
        const idxs = channels.split('').map((c: string) => map[c]);
        if (idxs.length === 1) return `${vec}[${idxs[0]}]`;
        return `std::array<float, ${idxs.length}>{${idxs.map((i: number) => `${vec}[${i}]`).join(', ')}}`;
      }

      default:
        throw new Error(`C++ Generator: Unsupported op '${node.op}'`);
    }
  }
}
