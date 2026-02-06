/**
 * MSL Generator
 * Generates Metal Shading Language code from IR for GPU compute execution.
 */

import { IRDocument, FunctionDef, Node, Edge, StructDef } from '../ir/types';
import { reconstructEdges } from '../ir/utils';

export interface MslOptions {
  globalBufferBinding?: number;
  varMap?: Map<string, number>;
  resourceBindings?: Map<string, number>;
  /** Custom kernel function name (default: 'main_kernel') */
  kernelName?: string;
  /** Skip Metal header (include, namespace) */
  skipHeader?: boolean;
}

export interface MslCompilationResult {
  code: string;
  metadata: {
    resourceBindings: Map<string, number>;
    globalBufferSize: number;
    varMap: Map<string, number>;
  };
}

export class MslGenerator {
  private ir?: IRDocument;

  compile(ir: IRDocument, entryPointId: string, options: MslOptions = {}): MslCompilationResult {
    this.ir = ir;
    const lines: string[] = [];

    // Metal header
    if (!options.skipHeader) {
      lines.push('#include <metal_stdlib>');
      lines.push('using namespace metal;');
      lines.push('');
    }

    // Find entry function and collect dependencies
    const entryFunc = ir.functions.find(f => f.id === entryPointId);
    if (!entryFunc) throw new Error(`Entry point '${entryPointId}' not found`);

    const allFunctions = this.collectFunctions(entryFunc, ir.functions);

    // Analyze variables for globals buffer allocation
    const varMap = options.varMap || new Map<string, number>();
    let varOffset = 0;

    // Allocate space for inputs.
    // If it's a shader function, use its own inputs. Otherwise use IR-global inputs.
    const inputs = (entryFunc.type === 'shader' ? entryFunc.inputs : ir.inputs) || [];
    inputs.forEach(input => {
      if (!varMap.has(input.id)) {
        varMap.set(input.id, varOffset);
        varOffset += this.getTypeSize(input.type);
      }
    });

    // Allocate space for local vars and any var_set targets
    for (const func of allFunctions) {
      for (const v of func.localVars || []) {
        if (!varMap.has(v.id)) {
          varMap.set(v.id, varOffset);
          varOffset += this.getTypeSize(v.type || 'float');
        }
      }
      for (const node of func.nodes) {
        if (node.op === 'var_set') {
          const varId = node['var'];
          if (!varMap.has(varId)) {
            varMap.set(varId, varOffset);
            varOffset++;
          }
        }
      }
    }

    const globalBufferSize = Math.max(varOffset * 4, 16);

    // Resource bindings
    const resourceBindings = options.resourceBindings || new Map<string, number>();
    let bindingCounter = 1; // 0 is reserved for globals
    for (const res of ir.resources || []) {
      if (!resourceBindings.has(res.id)) {
        resourceBindings.set(res.id, bindingCounter++);
      }
    }

    // Emit struct definitions
    this.emitStructs(ir.structs || [], lines);

    // Emit helper functions
    lines.push('// Helper functions');
    lines.push('inline float safe_div(float a, float b) { return b != 0.0f ? a / b : 0.0f; }');
    lines.push('inline float2 safe_div(float2 a, float b) { return b != 0.0f ? a / b : float2(0.0f); }');
    lines.push('inline float3 safe_div(float3 a, float b) { return b != 0.0f ? a / b : float3(0.0f); }');
    lines.push('inline float4 safe_div(float4 a, float b) { return b != 0.0f ? a / b : float4(0.0f); }');
    lines.push('inline float2 safe_div(float2 a, float2 b) { return float2(safe_div(a.x, b.x), safe_div(a.y, b.y)); }');
    lines.push('inline float3 safe_div(float3 a, float3 b) { return float3(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z)); }');
    lines.push('inline float4 safe_div(float4 a, float4 b) { return float4(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z), safe_div(a.w, b.w)); }');
    lines.push('');

    // Emit non-entry functions
    for (const func of allFunctions) {
      if (func.id !== entryPointId) {
        this.emitFunction(func, false, lines, allFunctions, varMap, resourceBindings);
      }
    }

    // Emit entry point as kernel
    this.emitKernel(entryFunc, lines, allFunctions, varMap, resourceBindings, options);

    return {
      code: lines.join('\n'),
      metadata: {
        resourceBindings,
        globalBufferSize,
        varMap
      }
    };
  }

  /**
   * Compiles multiple entry points into a single Metal library source string.
   */
  compileLibrary(ir: IRDocument, entryPointIds: string[], options: MslOptions = {}): MslCompilationResult {
    this.ir = ir;
    const lines: string[] = [];

    // Metal header
    if (!options.skipHeader) {
      lines.push('#include <metal_stdlib>');
      lines.push('using namespace metal;');
      lines.push('');
    }

    // Emit helper functions
    lines.push('// Helper functions');
    lines.push('inline float safe_div(float a, float b) { return b != 0.0f ? a / b : 0.0f; }');
    lines.push('inline float2 safe_div(float2 a, float b) { return b != 0.0f ? a / b : float2(0.0f); }');
    lines.push('inline float3 safe_div(float3 a, float b) { return b != 0.0f ? a / b : float3(0.0f); }');
    lines.push('inline float4 safe_div(float4 a, float b) { return b != 0.0f ? a / b : float4(0.0f); }');
    lines.push('inline float2 safe_div(float2 a, float2 b) { return float2(safe_div(a.x, b.x), safe_div(a.y, b.y)); }');
    lines.push('inline float3 safe_div(float3 a, float3 b) { return float3(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z)); }');
    lines.push('inline float4 safe_div(float4 a, float4 b) { return float4(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z), safe_div(a.w, b.w)); }');
    lines.push('');

    // Emit struct definitions
    this.emitStructs(ir.structs || [], lines);

    const emittedFunctions = new Set<string>();
    const varMap = options.varMap || new Map<string, number>();
    const resourceBindings = options.resourceBindings || new Map<string, number>();

    // Default resource bindings if not provided
    if (!options.resourceBindings) {
      let bindingCounter = 1;
      for (const res of ir.resources || []) {
        if (!resourceBindings.has(res.id)) {
          resourceBindings.set(res.id, bindingCounter++);
        }
      }
    }

    for (const entryId of entryPointIds) {
      const entryFunc = ir.functions.find(f => f.id === entryId);
      if (!entryFunc) continue;

      const allFunctions = this.collectFunctions(entryFunc, ir.functions);

      // Emit non-entry functions
      for (const func of allFunctions) {
        if (func.id !== entryId && !emittedFunctions.has(func.id)) {
          this.emitFunction(func, false, lines, allFunctions, varMap, resourceBindings);
          emittedFunctions.add(func.id);
        }
      }

      // Emit entry point as kernel
      const kernelOptions = { ...options, kernelName: entryId };
      this.emitKernel(entryFunc, lines, allFunctions, varMap, resourceBindings, kernelOptions);
      lines.push('');
    }

    return {
      code: lines.join('\n'),
      metadata: {
        resourceBindings,
        globalBufferSize: 0,
        varMap
      }
    };
  }

  private collectFunctions(entry: FunctionDef, all: FunctionDef[]): FunctionDef[] {
    const collected = new Set<string>([entry.id]);
    const queue = [entry];
    const result: FunctionDef[] = [];

    while (queue.length > 0) {
      const func = queue.shift()!;
      result.push(func);

      for (const node of func.nodes) {
        if (node.op === 'call_func') {
          const targetId = node['func'];
          if (!collected.has(targetId)) {
            const target = all.find(f => f.id === targetId);
            if (target) {
              collected.add(targetId);
              queue.push(target);
            }
          }
        }
      }
    }
    return result;
  }

  private emitStructs(structs: StructDef[], lines: string[]) {
    if (structs.length === 0) return;

    lines.push('// Struct definitions');
    for (const s of structs) {
      lines.push(`struct ${this.sanitizeId(s.id, 'struct')} {`);
      for (const m of s.members || []) {
        const mslType = this.irTypeToMsl(m.type);
        lines.push(`    ${mslType} ${this.sanitizeId(m.name, 'field')};`);
      }
      lines.push('};');
    }
    lines.push('');
  }

  private emitFunction(
    func: FunctionDef,
    _isEntry: boolean,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>
  ) {
    const returnType = func.outputs && func.outputs.length > 0 ? 'float' : 'void';
    const params = this.buildFuncParams(func);

    lines.push(`${returnType} ${this.sanitizeId(func.id, 'func')}(device float* b_globals${params}) {`);

    const edges = reconstructEdges(func);
    this.emitBody(func, lines, allFunctions, varMap, resourceBindings, edges);

    lines.push('}');
    lines.push('');
  }

  private emitKernel(
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    options: MslOptions = {}
  ) {
    lines.push('// Kernel entry point');

    // Build kernel signature with buffer bindings
    const bufferParams: string[] = [];

    if (func.type === 'shader' && func.inputs && func.inputs.length > 0) {
      // Emit inputs struct definition before kernel
      lines.push(`struct ${this.sanitizeId(func.id, 'struct')}_Inputs {`);
      for (const input of func.inputs) {
        const type = this.irTypeToMsl(input.type || 'float');
        lines.push(`  ${type} ${this.sanitizeId(input.id, 'field')};`);
      }
      lines.push('};');
      lines.push('');
      bufferParams.push(`constant ${this.sanitizeId(func.id, 'struct')}_Inputs& inputs [[buffer(0)]]`);
    } else {
      bufferParams.push('device float* b_globals [[buffer(0)]]');
    }

    for (const [resId, binding] of resourceBindings) {
      const res = this.ir?.resources.find(r => r.id === resId);
      if (res?.type === 'buffer') {
        const elemType = this.irTypeToMsl(res.dataType || 'float');
        bufferParams.push(`device ${elemType}* ${this.sanitizeId(resId, 'buffer')} [[buffer(${binding})]]`);
      } else if (res?.type === 'texture2d') {
        // Add texture and sampler bindings with distinct names
        bufferParams.push(`texture2d<float> ${this.sanitizeId(resId)}_tex [[texture(${binding})]]`);
        bufferParams.push(`sampler ${this.sanitizeId(resId)}_sampler [[sampler(${binding})]]`);
      }
    }

    const kernelName = options.kernelName || 'main_kernel';
    lines.push(`kernel void ${kernelName}(`);
    lines.push(`    ${bufferParams.join(',\n    ')},`);
    lines.push('    uint3 gid [[thread_position_in_grid]]) {');

    const edges = reconstructEdges(func);
    this.emitBody(func, lines, allFunctions, varMap, resourceBindings, edges);

    lines.push('}');
  }

  private emitBody(
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    edges: Edge[]
  ) {
    // Declare local variables with initial values
    for (const v of func.localVars || []) {
      const type = this.irTypeToMsl(v.type || 'float');
      lines.push(`    ${this.formatLocalVarDecl(v.id, type, v.initialValue as number | undefined)};`);
    }
    if ((func.localVars || []).length > 0) lines.push('');

    // Track emitted pure nodes
    const emittedPure = new Set<string>();
    const emitPure = (nodeId: string) => {
      if (emittedPure.has(nodeId)) return;
      const node = func.nodes.find(n => n.id === nodeId);
      if (node && this.hasResult(node.op) && !this.isExecutable(node.op)) {
        // Emit dependencies first
        for (const edge of edges) {
          if (edge.to === nodeId && edge.type === 'data') {
            emitPure(edge.from);
          }
        }
        const expr = this.compileExpression(node, func, allFunctions, varMap, resourceBindings, emitPure, edges);
        lines.push(`    auto ${this.nodeResId(node.id)} = ${expr};`);
        emittedPure.add(nodeId);
      }
    };

    // Find entry nodes and emit execution chain
    const entryNodes = func.nodes.filter(n =>
      n.op.startsWith('cmd_') ||
      this.isExecutable(n.op) && !edges.some(e => e.to === n.id && e.type === 'execution')
    );

    for (const entry of entryNodes) {
      this.emitChain(entry, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges);
    }
  }

  private emitChain(
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    visited: Set<string> = new Set(),
    indent: string = '    '
  ) {
    let curr: Node | undefined = node;

    while (curr) {
      if (visited.has(curr.id)) {
        if (curr.op !== 'flow_loop') break;
      }
      visited.add(curr.id);

      // Emit data dependencies
      for (const edge of edges) {
        if (edge.to === curr.id && edge.type === 'data') {
          emitPure(edge.from);
        }
      }
      // Also emit inline references
      for (const k in curr) {
        if (['id', 'op', 'metadata', 'func', 'args', 'dispatch'].includes(k)) continue;
        const val = (curr as any)[k];
        if (typeof val === 'string' && func.nodes.some(n => n.id === val)) emitPure(val);
      }

      // Handle control flow
      if (curr.op === 'flow_branch') {
        this.emitBranch(indent, curr, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, new Set(visited));
        return;
      } else if (curr.op === 'flow_loop') {
        this.emitLoop(indent, curr, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, new Set(visited));
        return;
      } else if (curr.op === 'func_return') {
        const val = this.resolveArg(curr, 'val', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        lines.push(`${indent}return ${val};`);
        return;
      } else {
        // Emit this node
        this.emitNode(curr, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, indent);
      }

      // Follow execution edges
      const nextEdge = edges.find(e => e.from === curr!.id && e.type === 'execution' && e.portOut === 'exec_out');
      curr = nextEdge ? func.nodes.find(n => n.id === nextEdge.to) : undefined;
    }
  }

  private emitBranch(
    indent: string,
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    visited: Set<string>
  ) {
    const cond = this.resolveArg(node, 'cond', func, allFunctions, varMap, resourceBindings, emitPure, edges);
    lines.push(`${indent}if (${cond}) {`);
    const trueEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_true' && e.type === 'execution');
    const trueNode = trueEdge ? func.nodes.find(n => n.id === trueEdge.to) : undefined;
    if (trueNode) this.emitChain(trueNode, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, new Set(visited), indent + '  ');
    lines.push(`${indent}} else {`);
    const falseEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_false' && e.type === 'execution');
    const falseNode = falseEdge ? func.nodes.find(n => n.id === falseEdge.to) : undefined;
    if (falseNode) this.emitChain(falseNode, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, new Set(visited), indent + '  ');
    lines.push(`${indent}}`);
  }

  private emitLoop(
    indent: string,
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    visited: Set<string>
  ) {
    const start = this.resolveArg(node, 'start', func, allFunctions, varMap, resourceBindings, emitPure, edges);
    const end = this.resolveArg(node, 'end', func, allFunctions, varMap, resourceBindings, emitPure, edges);
    const loopVar = `loop_${this.sanitizeId(node.id, 'var')}`;
    lines.push(`${indent}for (int ${loopVar} = int(${start}); ${loopVar} < int(${end}); ${loopVar}++) {`);

    const bodyEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_body' && e.type === 'execution');
    const bodyNode = bodyEdge ? func.nodes.find(n => n.id === bodyEdge.to) : undefined;
    if (bodyNode) this.emitChain(bodyNode, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, new Set(visited), indent + '  ');
    lines.push(`${indent}}`);

    const compEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_completed' && e.type === 'execution');
    const nextNode = compEdge ? func.nodes.find(n => n.id === compEdge.to) : undefined;
    if (nextNode) this.emitChain(nextNode, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, visited, indent);
  }

  private emitNode(
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    indent: string = '    '
  ) {
    if (node.op === 'var_set') {
      const valNodeRef = node['val'];
      const varId = node['var'];
      const varExpr = this.getVariableExpr(varId, func, varMap);

      // Check if the value is an array_construct - use loop-based init
      const valNode = typeof valNodeRef === 'string' ? func.nodes.find(n => n.id === valNodeRef) : null;
      if (valNode && valNode.op === 'array_construct') {
        const length = valNode['length'] as number || 1;
        const fill = valNode['fill'];
        const fillVal = fill !== undefined ? String(fill) : '0';
        // Emit loop-based initialization
        lines.push(`${indent}for (int _i = 0; _i < ${length}; _i++) ${varExpr}[_i] = ${fillVal};`);
      } else {
        const val = this.resolveArg(node, 'val', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        lines.push(`${indent}${varExpr} = ${val};`);
      }
    } else if (node.op === 'array_set') {
      const arrayNodeRef = node['array'];
      const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges);
      const val = this.resolveArg(node, 'value', func, allFunctions, varMap, resourceBindings, emitPure, edges);
      // Get the array expression - could be a var_get reference
      const arrExpr = this.resolveArg(node, 'array', func, allFunctions, varMap, resourceBindings, emitPure, edges);
      lines.push(`${indent}${arrExpr}[int(${idx})] = ${val};`);
    } else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'];
      const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges);
      const val = this.resolveArg(node, 'value', func, allFunctions, varMap, resourceBindings, emitPure, edges);
      const bufName = this.sanitizeId(bufferId, 'buffer');
      lines.push(`${indent}${bufName}[int(${idx})] = ${val};`);
    } else if (node.op === 'func_return') {
      const val = this.resolveArg(node, 'val', func, allFunctions, varMap, resourceBindings, emitPure, edges);
      lines.push(`    return ${val};`);
    } else if (this.hasResult(node.op)) {
      const expr = this.compileExpression(node, func, allFunctions, varMap, resourceBindings, emitPure, edges);
      lines.push(`    auto ${this.nodeResId(node.id)} = ${expr};`);
    }
  }

  private compileExpression(
    node: Node,
    func: FunctionDef,
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[]
  ): string {
    const a = (key = 'a') => this.resolveArg(node, key, func, allFunctions, varMap, resourceBindings, emitPure, edges);
    const b = () => this.resolveArg(node, 'b', func, allFunctions, varMap, resourceBindings, emitPure, edges);

    switch (node.op) {
      case 'literal':
      case 'float':
        return this.formatFloat(node['val']);
      case 'int':
        return `${node['val']}`;
      case 'bool':
        return node['val'] ? '1.0f' : '0.0f';

      case 'loop_index': {
        const loopId = node['loop'];
        return `loop_${this.sanitizeId(loopId, 'var')}`;
      }

      case 'var_get': {
        const varId = node['var'];
        return this.getVariableExpr(varId, func, varMap);
      }

      case 'buffer_load': {
        const bufferId = node['buffer'];
        const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        return `${this.sanitizeId(bufferId, 'buffer')}[int(${idx})]`;
      }

      // Vector constructors
      case 'float2': return `float2(${a('x')}, ${a('y')})`;
      case 'float3': return `float3(${a('x')}, ${a('y')}, ${a('z')})`;
      case 'float4': return `float4(${a('x')}, ${a('y')}, ${a('z')}, ${a('w')})`;

      // Constants
      case 'math_pi': return '3.14159265358979323846f';
      case 'math_e': return '2.71828182845904523536f';

      // Math ops - Metal uses same names as GLSL/WGSL
      case 'math_add': return `(${a()} + ${b()})`;
      case 'math_mad': return `fma(${a()}, ${b()}, ${a('c')})`;
      case 'math_select': return `(${a('cond')} != 0.0f ? ${a('true')} : ${a('false')})`;
      case 'math_sub': return `(${a()} - ${b()})`;
      case 'math_mul': return `(${a()} * ${b()})`;
      case 'math_div': return `safe_div(${a()}, ${b()})`;
      case 'math_neg': return `(-${a('val')})`;
      case 'math_abs': return `abs(${a('val')})`;
      case 'math_sin': return `sin(${a('val')})`;
      case 'math_cos': return `cos(${a('val')})`;
      case 'math_tan': return `tan(${a('val')})`;
      case 'math_asin': return `asin(${a('val')})`;
      case 'math_acos': return `acos(${a('val')})`;
      case 'math_atan': return `atan(${a('val')})`;
      case 'math_atan2': return `atan2(${a()}, ${b()})`;
      case 'math_sinh': return `sinh(${a('val')})`;
      case 'math_cosh': return `cosh(${a('val')})`;
      case 'math_tanh': return `tanh(${a('val')})`;
      case 'math_floor': return `floor(${a('val')})`;
      case 'math_ceil': return `ceil(${a('val')})`;
      case 'math_round': return `round(${a('val')})`;
      case 'math_sqrt': return `sqrt(${a('val')})`;
      case 'math_pow': return `pow(${a()}, ${b()})`;
      case 'math_exp': return `exp(${a('val')})`;
      case 'math_exp2': return `exp2(${a('val')})`;
      case 'math_log': return `log(${a('val')})`;
      case 'math_log2': return `log2(${a('val')})`;
      case 'math_min': return `min(${a()}, ${b()})`;
      case 'math_max': return `max(${a()}, ${b()})`;
      case 'math_clamp': return `clamp(${a('val')}, ${a('min')}, ${a('max')})`;
      case 'math_mod': return `fmod(${a()}, ${b()})`;
      case 'math_fract': return `fract(${a('val')})`;
      case 'math_sign': return `sign(${a('val')})`;
      case 'math_step': return `step(${a('edge')}, ${a('val')})`;
      case 'math_smoothstep': return `smoothstep(${a('edge0')}, ${a('edge1')}, ${a('val')})`;
      case 'math_mix': return `mix(${a()}, ${b()}, ${a('t')})`;
      case 'math_lerp': return `mix(${a()}, ${b()}, ${a('t')})`;

      // Comparisons
      case 'math_eq': return `(${a()} == ${b()} ? 1.0f : 0.0f)`;
      case 'math_neq': return `(${a()} != ${b()} ? 1.0f : 0.0f)`;
      case 'math_lt': return `(${a()} < ${b()} ? 1.0f : 0.0f)`;
      case 'math_lte': return `(${a()} <= ${b()} ? 1.0f : 0.0f)`;
      case 'math_gt': return `(${a()} > ${b()} ? 1.0f : 0.0f)`;
      case 'math_gte': return `(${a()} >= ${b()} ? 1.0f : 0.0f)`;

      // Vector ops
      case 'vec_dot': return `dot(${a()}, ${b()})`;
      case 'vec_length': return `length(${a()})`;
      case 'vec_normalize': return `normalize(${a()})`;
      case 'vec_mix': return `mix(${a()}, ${b()}, ${a('t')})`;
      case 'vec_cross': return `cross(${a()}, ${b()})`;
      case 'vec_distance': return `distance(${a()}, ${b()})`;
      case 'vec_reflect': return `reflect(${a()}, ${a('n')})`;

      case 'vec_swizzle': {
        const vec = this.resolveArg(node, 'vec', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        const channels = node['channels'] || node['swizzle'] || 'x';
        return `${vec}.${channels}`;
      }

      case 'resource_get_size': {
        // Return buffer size as a float3 (for compatibility with vec_get_element)
        // TODO: We _must_ support dynamically sized resources! This doesn't work yet.
        const resId = node['resource'];
        const resDef = this.ir?.resources.find(r => r.id === resId);
        const size = resDef?.size && typeof resDef.size === 'object' && 'value' in resDef.size
          ? resDef.size.value : 1;
        // For buffers, return (size, 1, 1)
        if (typeof size === 'number') {
          return `float3(${this.formatFloat(size)}, 1.0f, 1.0f)`;
        }
        return 'float3(1.0f, 1.0f, 1.0f)';
      }

      case 'vec_get_element': {
        const vec = this.resolveArg(node, 'vec', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        return `${vec}[int(${idx})]`;
      }

      // Type casting
      case 'static_cast_float': return `float(${a('val')})`;
      case 'static_cast_int': return `int(${a('val')})`;
      case 'static_cast_bool': return `(${a('val')} != 0.0f ? 1.0f : 0.0f)`;

      // Struct operations
      case 'struct_construct': {
        const structType = node['type'] as string;
        const valuesObj = node['values'] as Record<string, any> || {};
        const structDef = this.ir?.structs.find(s => s.id === structType);
        if (!structDef) throw new Error(`MslGenerator: Struct '${structType}' not found`);

        // Build constructor with members in order
        const memberExprs: string[] = [];
        for (const m of structDef.members || []) {
          const val = valuesObj[m.name];
          if (val !== undefined) {
            if (typeof val === 'number') {
              memberExprs.push(this.formatFloat(val));
            } else if (typeof val === 'string') {
              const refNode = func.nodes.find(n => n.id === val);
              if (refNode) {
                emitPure(val);
                memberExprs.push(this.nodeResId(val));
              } else {
                memberExprs.push(this.getVariableExpr(val, func, varMap));
              }
            } else {
              memberExprs.push(String(val));
            }
          } else {
            memberExprs.push('{}'); // Default init
          }
        }
        return `${this.sanitizeId(structType, 'struct')}{${memberExprs.join(', ')}}`;
      }

      case 'struct_extract': {
        const structExpr = this.resolveArg(node, 'struct', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        const field = node['field'] as string;
        return `${structExpr}.${this.sanitizeId(field, 'field')}`;
      }

      // Array operations
      case 'array_construct': {
        const length = node['length'] as number || 1;
        const fill = node['fill'];
        const fillVal = fill !== undefined ? this.formatFloat(fill as number) : '0.0f';
        // Use Metal array syntax
        const elements = new Array(length).fill(fillVal);
        return `{ ${elements.join(', ')} }`;
      }

      case 'array_extract': {
        const arrExpr = this.resolveArg(node, 'array', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        return `${arrExpr}[int(${idx})]`;
      }

      case 'call_func': {
        const targetId = node['func'] as string;
        const targetFunc = allFunctions.find(f => f.id === targetId);
        if (!targetFunc) throw new Error(`MslGenerator: Function '${targetId}' not found`);

        // Build args list matching target function's inputs
        const argExprs: string[] = ['b_globals'];
        for (const inp of targetFunc.inputs || []) {
          const argVal = node['args']?.[inp.id];
          if (argVal !== undefined) {
            if (typeof argVal === 'number') {
              argExprs.push(this.formatFloat(argVal));
            } else if (typeof argVal === 'string') {
              const refNode = func.nodes.find(n => n.id === argVal);
              if (refNode) {
                emitPure(argVal);
                argExprs.push(this.nodeResId(argVal));
              } else {
                argExprs.push(this.getVariableExpr(argVal, func, varMap));
              }
            } else {
              argExprs.push(String(argVal));
            }
          } else {
            argExprs.push('0.0f');
          }
        }
        return `${this.sanitizeId(targetId, 'func')}(${argExprs.join(', ')})`;
      }

      case 'texture_sample': {
        const texId = node['tex'] as string;
        const uvVal = node['uv'];
        let uvExpr: string;

        if (Array.isArray(uvVal)) {
          uvExpr = `float2(${this.formatFloat(uvVal[0])}, ${this.formatFloat(uvVal[1])})`;
        } else if (typeof uvVal === 'string') {
          const refNode = func.nodes.find(n => n.id === uvVal);
          if (refNode) {
            emitPure(uvVal);
            uvExpr = this.nodeResId(uvVal);
          } else {
            uvExpr = this.getVariableExpr(uvVal, func, varMap);
          }
        } else {
          uvExpr = 'float2(0.0f, 0.0f)';
        }

        // Metal sampling syntax: texture.sample(sampler, uv)
        return `${this.sanitizeId(texId)}_tex.sample(${this.sanitizeId(texId)}_sampler, ${uvExpr})`;
      }

      default:
        throw new Error(`MSL Generator: Unsupported op '${node.op}'`);
    }
  }

  private getVariableExpr(varId: string, func: FunctionDef, varMap: Map<string, number>): string {
    // Check if it's a shader function input
    if (func.type === 'shader' && func.inputs?.some(i => i.id === varId)) {
      return `inputs.${this.sanitizeId(varId, 'field')}`;
    }

    // Check if it's a local variable
    if (func.localVars?.some(v => v.id === varId)) {
      return this.sanitizeId(varId, 'var');
    }

    const offset = varMap.get(varId);
    if (offset !== undefined) {
      return `b_globals[${offset}]`;
    }

    return this.sanitizeId(varId, 'var'); // Default to local
  }

  private resolveArg(
    node: Node,
    key: string,
    func: FunctionDef,
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[]
  ): string {
    // Check for edge connection
    const edge = edges.find(e => e.to === node.id && (e.portIn === key || (key === 'val' && e.portIn === 'value')) && e.type === 'data');
    if (edge) {
      const source = func.nodes.find(n => n.id === edge.from);
      if (source) {
        return this.compileExpression(source, func, allFunctions, varMap, resourceBindings, emitPure, edges);
      }
    }

    // Check for inline literal
    const val = node[key];
    if (val === undefined) return '0.0f';
    if (typeof val === 'number') return this.formatFloat(val);
    if (typeof val === 'boolean') return val ? '1.0f' : '0.0f';
    if (Array.isArray(val)) {
      // Format as Metal vector
      const len = val.length;
      const elements = val.map((v: number) => this.formatFloat(v)).join(', ');
      if (len === 2) return `float2(${elements})`;
      if (len === 3) return `float3(${elements})`;
      if (len === 4) return `float4(${elements})`;
      return `float${len}(${elements})`;
    }
    if (typeof val === 'string') {
      // Node reference
      const refNode = func.nodes.find(n => n.id === val);
      if (refNode) {
        emitPure(val);
        return this.nodeResId(val);
      }

      // Variable reference (input or local)
      return this.getVariableExpr(val, func, varMap);
    }
    return String(val);
  }

  private hasResult(op: string): boolean {
    const valueOps = [
      'literal', 'float', 'int', 'bool',
      'var_get', 'buffer_load',
      'float2', 'float3', 'float4',
      'vec_dot', 'vec_length', 'vec_normalize', 'vec_swizzle', 'vec_get_element',
      'struct_construct', 'struct_extract',
      'array_construct', 'array_extract',
      'call_func'
    ];
    return valueOps.includes(op) || op.startsWith('math_') || op.startsWith('vec_');
  }

  private isExecutable(op: string): boolean {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'func_return' || op === 'call_func' || op === 'array_set';
  }

  private formatFloat(val: number): string {
    const s = val.toString();
    if (!s.includes('.') && !s.includes('e') && !s.includes('E')) {
      return s + '.0f';
    }
    return s + 'f';
  }

  private sanitizeId(id: string, type: 'var' | 'func' | 'struct' | 'field' | 'buffer' = 'var'): string {
    const clean = id.replace(/[^a-zA-Z0-9_]/g, '_');
    if (type === 'func') return `func_${clean}`;
    if (type === 'struct') return `S_${clean}`;
    if (type === 'field') return `f_${clean}`;
    if (type === 'buffer') return `b_${clean}`;
    return `v_${clean}`;
  }

  private nodeResId(id: string): string {
    return `n_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  private irTypeToMsl(irType: string | undefined): string {
    if (!irType) return 'float';
    switch (irType) {
      case 'float': return 'float';
      case 'int': case 'i32': return 'int';
      case 'uint': case 'u32': return 'uint';
      case 'bool': return 'bool';
      case 'float2': return 'float2';
      case 'float3': return 'float3';
      case 'float4': return 'float4';
      default:
        if (irType.startsWith('array<')) {
          // Parse array<elem, len> and return Metal array type
          const match = irType.match(/array<([^,]+),\s*(\d+)>/);
          if (match) {
            const elemType = this.irTypeToMsl(match[1].trim());
            const len = match[2];
            // Return special marker that caller handles for local vars
            return `__array_${elemType}_${len}`;
          }
          return 'float'; // fallback
        }
        return this.sanitizeId(irType, 'struct');
    }
  }

  // Helper to format local var declaration with array handling
  private formatLocalVarDecl(varId: string, type: string, init?: number): string {
    if (type.startsWith('__array_')) {
      // Parse __array_elemType_len - strip prefix, then split
      const stripped = type.substring('__array_'.length); // e.g., "int_3"
      const lastUnderscore = stripped.lastIndexOf('_');
      const elemType = stripped.substring(0, lastUnderscore);
      const len = stripped.substring(lastUnderscore + 1);
      return `${elemType} ${this.sanitizeId(varId)}[${len}]`;
    }
    const initStr = init !== undefined ? ` = ${this.formatFloat(init)}` : '';
    return `${type} ${this.sanitizeId(varId)}${initStr}`;
  }

  private getTypeSize(type: string | undefined): number {
    if (!type) return 1;
    if (type === 'float2') return 2;
    if (type === 'float3') return 3;
    if (type === 'float4') return 4;
    return 1;
  }

  private buildFuncParams(func: FunctionDef): string {
    if (!func.inputs || func.inputs.length === 0) return '';
    return ', ' + func.inputs.map(i => `float ${this.sanitizeId(i.id, 'var')}`).join(', ');
  }
}
