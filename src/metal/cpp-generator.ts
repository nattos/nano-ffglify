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
    const entryFunc = allFunctions.find((f: FunctionDef) => f.id === entryPointId);
    if (!entryFunc) throw new Error(`Entry point '${entryPointId}' not found`);

    // Collect all required functions via call graph traversal
    const requiredFuncs = new Set<string>();
    const callStack: string[] = [];

    const collectFunctions = (funcId: string) => {
      // Check for recursion
      if (callStack.includes(funcId)) {
        throw new Error(`Recursion detected: ${callStack.join(' -> ')} -> ${funcId}`);
      }
      if (requiredFuncs.has(funcId)) return;

      const func = allFunctions.find((f: FunctionDef) => f.id === funcId);
      if (!func) throw new Error(`Function '${funcId}' not found`);

      requiredFuncs.add(funcId);
      callStack.push(funcId);

      // Find all call_func nodes in this function
      for (const node of func.nodes) {
        if (node.op === 'call_func') {
          const targetFunc = node['func'];
          if (targetFunc) collectFunctions(targetFunc);
        }
      }

      callStack.pop();
    };

    collectFunctions(entryPointId);

    const lines: string[] = [];
    lines.push('// Generated C++ code from IR');
    lines.push('// Entry point: ' + entryFunc.id);
    lines.push('');

    // Emit struct definitions
    if (ir.structs && ir.structs.length > 0) {
      lines.push('// Struct definitions');
      for (const s of ir.structs) {
        lines.push(`struct ${this.sanitizeId(s.id, 'struct')} {`);
        for (const m of s.members || []) {
          const cppType = this.irTypeToCpp(m.type);
          lines.push(`    ${cppType} ${this.sanitizeId(m.name, 'field')};`);
        }
        lines.push('};');
      }
      lines.push('');
    }

    // Forward declarations
    for (const funcId of requiredFuncs) {
      const func = allFunctions.find((f: FunctionDef) => f.id === funcId)!;
      const hasReturn = func.outputs && func.outputs.length > 0;
      const returnType = hasReturn ? 'float' : 'void';
      const params = this.buildFuncParams(func);
      lines.push(`${returnType} ${this.sanitizeId(funcId, 'func')}(EvalContext& ctx${params});`);
    }
    lines.push('');

    // Collect resource IDs for the harness
    const resourceIds = ir.resources.map(r => r.id);

    // Emit all required functions (reverse order so dependencies come first)
    const funcList = Array.from(requiredFuncs).reverse();
    for (const funcId of funcList) {
      const func = allFunctions.find((f: FunctionDef) => f.id === funcId)!;
      this.emitFunction(func, lines, allFunctions);
      lines.push('');
    }

    // Emit func_main wrapper if entry point has a different name
    const entryFuncName = this.sanitizeId(entryPointId, 'func');
    if (entryFuncName !== 'func_main') {
      lines.push('// Entry point wrapper for harness');
      lines.push(`void func_main(EvalContext& ctx) { ${entryFuncName}(ctx); }`);
      lines.push('');
    }

    return {
      code: lines.join('\n'),
      resourceIds,
    };
  }

  /**
   * Build function parameter list string
   */
  private buildFuncParams(func: FunctionDef): string {
    if (!func.inputs || func.inputs.length === 0) return '';
    const params = func.inputs.map(inp => `float ${this.sanitizeId(inp.id, 'input')}`);
    return ', ' + params.join(', ');
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

  private sanitizeId(id: string, type: 'input' | 'var' | 'func' | 'struct' | 'field' = 'var'): string {
    const clean = id.replace(/[^a-zA-Z0-9_]/g, '_');
    if (type === 'input') return `i_${clean}`;
    if (type === 'func') return `func_${clean}`;
    if (type === 'struct') return `S_${clean}`;
    if (type === 'field') return `f_${clean}`;
    return `v_${clean}`;
  }

  /**
   * Convert IR type to C++ type
   */
  private irTypeToCpp(irType: string): string {
    switch (irType) {
      case 'float': return 'float';
      case 'int': case 'i32': return 'int';
      case 'uint': case 'u32': return 'unsigned int';
      case 'bool': return 'bool';
      case 'float2': return 'std::array<float, 2>';
      case 'float3': return 'std::array<float, 3>';
      case 'float4': return 'std::array<float, 4>';
      default:
        // Check for array types like array<i32, 3>
        const arrayMatch = irType.match(/array<([^,]+),\s*(\d+)>/);
        if (arrayMatch) {
          const elemType = this.irTypeToCpp(arrayMatch[1]);
          return `std::array<${elemType}, ${arrayMatch[2]}>`;
        }
        // Assume it's a struct type
        return this.sanitizeId(irType, 'struct');
    }
  }

  private nodeResId(id: string): string {
    return `n_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  private emitFunction(f: FunctionDef, lines: string[], allFunctions: FunctionDef[]) {
    const hasReturn = f.outputs && f.outputs.length > 0;
    const returnType = hasReturn ? 'float' : 'void';
    const params = this.buildFuncParams(f);
    lines.push(`${returnType} ${this.sanitizeId(f.id, 'func')}(EvalContext& ctx${params}) {`);

    // Declare local variables
    for (const v of f.localVars) {
      const cppType = this.irTypeToCpp(v.type || 'float');
      const init = v.initialValue !== undefined
        ? (typeof v.initialValue === 'number' ? this.formatFloat(v.initialValue) : String(v.initialValue))
        : '{}';
      lines.push(`    ${cppType} ${this.sanitizeId(v.id, 'var')} = ${init};`);
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
      'vec_get_element', 'call_func',
      'struct_construct', 'struct_extract',
      'array_construct', 'array_extract',
    ];
    return valueOps.includes(op) || op.startsWith('math_') || op.startsWith('vec_');
  }

  private isExecutable(op: string): boolean {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'func_return' || op === 'call_func' || op === 'array_set';
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
        // Get return value if any
        const retVal = this.resolveArg(curr, 'val', func, allFunctions, emitPure, edges);
        if (retVal && retVal !== '0.0f') {
          lines.push(`${indent}return ${retVal};`);
        } else {
          lines.push(`${indent}return;`);
        }
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
      // Find buffer index and data type in resources
      const bufferIdx = this.ir?.resources.findIndex(r => r.id === bufferId) ?? -1;
      const bufferDef = this.ir?.resources.find(r => r.id === bufferId);
      const dataType = bufferDef?.dataType || 'float';

      // For vector buffers, store the complete vector at the index
      if (dataType === 'float4' || dataType === 'float3' || dataType === 'float2') {
        lines.push(`${indent}ctx.resources[${bufferIdx}]->storeVec(${idx}, ${val});`);
      } else {
        lines.push(`${indent}ctx.resources[${bufferIdx}]->data[static_cast<size_t>(${idx})] = ${val};`);
      }
    } else if (node.op === 'array_set') {
      // array_set modifies a variable in-place, need to find the actual variable name
      // Trace back through the data edge to find the var_get node
      const arrayEdge = edges.find(e => e.to === node.id && e.portIn === 'array' && e.type === 'data');
      let varName: string | undefined;
      if (arrayEdge) {
        const sourceNode = func.nodes.find(n => n.id === arrayEdge.from);
        if (sourceNode && sourceNode.op === 'var_get') {
          varName = this.sanitizeId(sourceNode['var'], 'var');
        }
      }
      if (!varName) {
        // Fallback: resolve normally (might create a copy issue)
        varName = this.resolveArg(node, 'array', func, allFunctions, emitPure, edges);
      }
      const idx = this.resolveArg(node, 'index', func, allFunctions, emitPure, edges);
      const val = this.resolveArg(node, 'value', func, allFunctions, emitPure, edges);
      lines.push(`${indent}${varName}[static_cast<size_t>(${idx})] = ${val};`);
    } else if (this.hasResult(node.op)) {
      // Executable nodes with results (like call_func) need auto declarations
      const expr = this.compileExpression(node, func, allFunctions, true, emitPure, edges);
      lines.push(`${indent}auto ${this.nodeResId(node.id)} = ${expr};`);
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
        throw new Error(`Variable '${varId}' is not defined`);
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

      // Math ops - inlined for simpler code
      case 'math_neg': return `(-(${val()}))`;
      case 'math_abs': return `abs(${val()})`;
      case 'math_sign': { const v = val(); return `((${v}) > 0.0f ? 1.0f : ((${v}) < 0.0f ? -1.0f : 0.0f))`; }
      case 'math_sin': return `sin(${val()})`;
      case 'math_cos': return `cos(${val()})`;
      case 'math_tan': return `tan(${val()})`;
      case 'math_asin': return `asin(${val()})`;
      case 'math_acos': return `acos(${val()})`;
      case 'math_atan': return `atan(${val()})`;
      case 'math_sqrt': return `sqrt(${val()})`;
      case 'math_exp': return `exp(${val()})`;
      case 'math_log': return `log(${val()})`;
      case 'math_ceil': return `ceil(${val()})`;
      case 'math_floor': return `floor(${val()})`;
      case 'math_trunc': return `trunc(${val()})`;
      case 'math_fract': { const v = val(); return `((${v}) - floor(${v}))`; }

      case 'math_add': return `((${a()}) + (${b()}))`;
      case 'math_sub': return `((${a()}) - (${b()}))`;
      case 'math_mul': return `((${a()}) * (${b()}))`;
      case 'math_div': return `((${a()}) / (${b()}))`;
      case 'math_mod': return `fmod(${a()}, ${b()})`;
      case 'math_pow': return `pow(${a()}, ${b()})`;
      case 'math_min': return `std::min(${a()}, ${b()})`;
      case 'math_max': return `std::max(${a()}, ${b()})`;
      case 'math_atan2': return `atan2(${a()}, ${b()})`;

      case 'math_gt': return `((${a()}) > (${b()}) ? 1.0f : 0.0f)`;
      case 'math_lt': return `((${a()}) < (${b()}) ? 1.0f : 0.0f)`;
      case 'math_ge': return `((${a()}) >= (${b()}) ? 1.0f : 0.0f)`;
      case 'math_le': return `((${a()}) <= (${b()}) ? 1.0f : 0.0f)`;
      case 'math_eq': return `((${a()}) == (${b()}) ? 1.0f : 0.0f)`;
      case 'math_neq': return `((${a()}) != (${b()}) ? 1.0f : 0.0f)`;

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

      case 'vec_get_element': {
        const vec = this.resolveArg(node, 'vec', func, allFunctions, emitPure, edges);
        const idx = this.resolveArg(node, 'index', func, allFunctions, emitPure, edges);
        return `${vec}[static_cast<size_t>(${idx})]`;
      }

      case 'call_func': {
        const targetFunc = node['func'];
        const targetFuncDef = allFunctions.find((f: FunctionDef) => f.id === targetFunc);
        if (!targetFuncDef) throw new Error(`C++ Generator: Function '${targetFunc}' not found`);

        // Build argument list from 'args' property
        const args: string[] = [];
        const argsObj = node['args'] || {};
        for (const input of targetFuncDef.inputs || []) {
          const argValue = argsObj[input.id];
          if (argValue !== undefined) {
            if (typeof argValue === 'number') {
              args.push(this.formatFloat(argValue));
            } else if (typeof argValue === 'string') {
              // Could be a node ref or variable
              const refNode = func.nodes.find(n => n.id === argValue);
              if (refNode) {
                emitPure(argValue);
                args.push(this.nodeResId(argValue));
              } else if (func.localVars.some(v => v.id === argValue)) {
                args.push(this.sanitizeId(argValue, 'var'));
              } else if (func.inputs.some(i => i.id === argValue)) {
                args.push(this.sanitizeId(argValue, 'input'));
              } else {
                args.push(argValue);
              }
            } else {
              args.push(String(argValue));
            }
          } else {
            args.push('0.0f');
          }
        }

        const argsStr = args.length > 0 ? ', ' + args.join(', ') : '';
        return `${this.sanitizeId(targetFunc, 'func')}(ctx${argsStr})`;
      }

      // Struct ops
      case 'struct_construct': {
        const typeName = node['type'];
        const structDef = this.ir?.structs?.find(s => s.id === typeName);
        if (!structDef) throw new Error(`C++ Generator: Struct type '${typeName}' not found`);

        const cppTypeName = this.sanitizeId(typeName, 'struct');
        const values = node['values'] || {};

        // Build initializer list in member order
        const initItems: string[] = [];
        for (const member of structDef.members || []) {
          const fieldVal = values[member.name];
          if (fieldVal !== undefined) {
            if (typeof fieldVal === 'number') {
              initItems.push(this.formatFloat(fieldVal));
            } else if (typeof fieldVal === 'string') {
              // Node reference
              emitPure(fieldVal);
              initItems.push(this.nodeResId(fieldVal));
            } else {
              initItems.push(String(fieldVal));
            }
          } else {
            initItems.push('{}'); // Default initialize
          }
        }
        return `${cppTypeName}{${initItems.join(', ')}}`;
      }

      case 'struct_extract': {
        const structExpr = this.resolveArg(node, 'struct', func, allFunctions, emitPure, edges);
        const fieldName = node['field'];
        return `${structExpr}.${this.sanitizeId(fieldName, 'field')}`;
      }

      // Array ops
      case 'array_construct': {
        const length = node['length'] || 0;
        const fill = node['fill'];
        // Determine element type based on fill value
        const isInt = fill !== undefined && typeof fill === 'number' && Number.isInteger(fill);
        const elemType = isInt ? 'int' : 'float';
        const fillExpr = fill !== undefined
          ? (typeof fill === 'number' ? (isInt ? String(fill) : this.formatFloat(fill)) : String(fill))
          : (isInt ? '0' : '0.0f');
        return `({auto _arr = std::array<${elemType}, ${length}>{}; for(auto& _e : _arr) _e = ${fillExpr}; _arr;})`;
      }

      case 'array_extract': {
        const arrExpr = this.resolveArg(node, 'array', func, allFunctions, emitPure, edges);
        const idx = this.resolveArg(node, 'index', func, allFunctions, emitPure, edges);
        return `${arrExpr}[static_cast<size_t>(${idx})]`;
      }

      default:
        throw new Error(`C++ Generator: Unsupported op '${node.op}'`);
    }
  }
}
