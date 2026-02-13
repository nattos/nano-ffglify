/**
 * C++ Code Generator for IR execution
 * Generates standalone C++ code from IR, modeled after cpu-jit.ts
 */

import { IRDocument, FunctionDef, Node, Edge } from '../ir/types';
import { reconstructEdges } from '../ir/utils';
import { inferFunctionTypes, InferredTypes, analyzeFunction, FunctionAnalysis } from '../ir/validator';
import { BUILTIN_CPU_ALLOWED } from '../ir/builtin-schemas';

const isCppDebugEnabled = () => {
  try {
    return typeof process !== 'undefined' && process.env && process.env.CPP_DEBUG;
  } catch (e) {
    return false;
  }
};

export interface ShaderFunctionInfo {
  id: string;
  inputs: { id: string; type: string }[];
  stage?: 'compute' | 'vertex' | 'fragment';
}

export interface CppCompileResult {
  code: string;
  resourceIds: string[];
  shaderFunctions: ShaderFunctionInfo[];
}

/**
 * C++ Code Generator
 * Compiles IR functions to standalone C++ code for CPU execution
 */
export class CppGenerator {
  private ir?: IRDocument;
  private functionAnalysis = new Map<string, FunctionAnalysis>();

  /**
   * Compile an IR document to C++ source code
   */
  compile(ir: IRDocument, entryPointId: string): CppCompileResult {
    this.ir = ir;
    this.functionAnalysis.clear();
    const allFunctions = ir.functions;
    const entryFunc = allFunctions.find((f: FunctionDef) => f.id === entryPointId);
    if (!entryFunc) throw new Error(`Entry point '${entryPointId}' not found`);

    // Collect all required functions via call graph traversal
    const requiredFuncs = new Set<string>();
    const callStack: string[] = [];
    const shaderFuncs = new Map<string, { func: FunctionDef, stage: 'compute' | 'vertex' | 'fragment' }>();
    if (entryFunc.type === 'shader') {
      shaderFuncs.set(entryPointId, { func: entryFunc, stage: 'compute' });
    }

    const collectFunctions = (funcId: string) => {
      // Check for recursion
      if (callStack.includes(funcId)) {
        throw new Error(`Recursion detected: ${callStack.join(' -> ')} -> ${funcId}`);
      }
      if (requiredFuncs.has(funcId)) return;

      const func = allFunctions.find((f: FunctionDef) => f.id === funcId);
      if (!func) throw new Error(`Function '${funcId}' not found`);

      // Skip shader functions from C++ emission (they run on GPU)
      if (func.type === 'shader') return;

      requiredFuncs.add(funcId);
      callStack.push(funcId);

      // Find all call_func and cmd_dispatch nodes in this function
      for (const node of func.nodes) {
        if (node.op === 'call_func') {
          const targetFunc = node['func'];
          if (targetFunc) collectFunctions(targetFunc);
        } else if (node.op === 'cmd_dispatch') {
          // Track shader function for Metal compilation
          const targetFunc = node['func'];
          if (targetFunc) {
            const shaderFunc = allFunctions.find((f: FunctionDef) => f.id === targetFunc);
            if (shaderFunc && shaderFunc.type === 'shader') {
              shaderFuncs.set(targetFunc, { func: shaderFunc, stage: 'compute' });
            }
          }
        } else if (node.op === 'cmd_draw') {
          const vertexFunc = node['vertex'];
          const fragmentFunc = node['fragment'];
          if (vertexFunc) {
            const shaderFunc = allFunctions.find((f: FunctionDef) => f.id === vertexFunc);
            if (shaderFunc && shaderFunc.type === 'shader') {
              shaderFuncs.set(vertexFunc, { func: shaderFunc, stage: 'vertex' });
            }
          }
          if (fragmentFunc) {
            const shaderFunc = allFunctions.find((f: FunctionDef) => f.id === fragmentFunc);
            if (shaderFunc && shaderFunc.type === 'shader') {
              shaderFuncs.set(fragmentFunc, { func: shaderFunc, stage: 'fragment' });
            }
          }
        }
      }

      callStack.pop();
    };

    collectFunctions(entryPointId);

    // Infer types and analyze functions
    const inferredTypes = new Map<string, InferredTypes>();
    for (const func of allFunctions) {
      if (requiredFuncs.has(func.id) || func.id === entryPointId) {
        const analysis = analyzeFunction(func, ir);
        inferredTypes.set(func.id, analysis.inferredTypes);
        this.functionAnalysis.set(func.id, analysis);
      }
    }
    // Also analyze shader functions (for builtin injection during dispatch)
    for (const [id, info] of shaderFuncs) {
      if (!this.functionAnalysis.has(id)) {
        this.functionAnalysis.set(id, analyzeFunction(info.func, ir));
      }
    }

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

    // Collect resource IDs for the harness in the correct order
    const resourceIds = this.getAllResources().map(r => r.id);

    // Emit all required functions (reverse order so dependencies come first)
    const funcList = Array.from(requiredFuncs).reverse();
    for (const funcId of funcList) {
      const func = allFunctions.find((f: FunctionDef) => f.id === funcId)!;
      this.emitFunction(func, lines, allFunctions, inferredTypes);
      lines.push('');
    }

    // Emit func_main wrapper if entry point has a different name
    const entryFuncName = this.sanitizeId(entryPointId, 'func');

    if (entryFunc.type === 'shader') {
      lines.push('// Entry point wrapper for shader harness');
      lines.push('void func_main(EvalContext& ctx) {');
      lines.push('    std::vector<float> _shader_args;');
      for (const input of (this.ir!.inputs || [])) {
        const irType = input.type || 'float';
        const argExpr = `ctx.getInput("${input.id}")`;
        this.emitArgFlattening('    ', argExpr, irType, lines);
      }
      // Dispatch with default 1,1,1 for test harness
      lines.push(`    ctx.dispatchShader("${entryPointId}", 1, 1, 1, _shader_args);`);
      lines.push('}');
      lines.push('');
    } else if (entryFuncName !== 'func_main') {
      const entryFunc = allFunctions.find(f => f.id === entryPointId)!;
      lines.push('// Entry point wrapper for harness');
      lines.push(`void func_main(EvalContext& ctx) { ${entryFuncName}(ctx); }`);
      lines.push('');
    }

    // FFGL Plugin Helpers (guarded - only compiled when PLUGIN_CLASS is defined)
    lines.push('#ifdef PLUGIN_CLASS');
    lines.push('void PLUGIN_CLASS::init_plugin() {');
    const params = ir.inputs.filter(i => i.type !== 'texture2d');
    params.forEach((p, idx) => {
      const label = p.label || p.id;
      let def = p.default !== undefined ? p.default : 0.5;
      if (Array.isArray(def)) {
        def = def[0] !== undefined ? def[0] : 0.0;
      }
      lines.push(`    SetParamInfo(${idx}, "${label}", FF_TYPE_STANDARD, ${this.formatFloat(def as any)});`);
    });
    lines.push('}');
    lines.push('');

    lines.push('void PLUGIN_CLASS::map_params(EvalContext& ctx) {');
    params.forEach((p, idx) => {
      // Map back to inputs. Scale can be handled here or in IR math.
      // For now, standard 0..1 mapping.
      lines.push(`    ctx.inputs["${p.id}"] = GetFloatParameter(${idx});`);
    });
    lines.push('}');
    lines.push('');

    lines.push('void PLUGIN_CLASS::setup_resources(EvalContext& ctx, ResourceState* outputRes, const std::vector<ResourceState*>& inputRes) {');
    lines.push('    // 1. Outputs first');
    lines.push('    ctx.resources.push_back(outputRes);');
    lines.push('    ctx.isTextureResource.push_back(true);');
    lines.push('    ctx.texWidths.push_back(outputRes->width);');
    lines.push('    ctx.texHeights.push_back(outputRes->height);');
    lines.push('');
    lines.push('    // 2. Texture inputs second');
    lines.push('    for (auto* res : inputRes) {');
    lines.push('        ctx.resources.push_back(res);');
    lines.push('        ctx.isTextureResource.push_back(true);');
    lines.push('        ctx.texWidths.push_back(res->width);');
    lines.push('        ctx.texHeights.push_back(res->height);');
    lines.push('    }');
    lines.push('');

    lines.push('    // 3. Other internal resources last');
    const internalRes = ir.resources.filter(r => !r.isOutput);
    internalRes.forEach((r, idx) => {
      lines.push(`    ctx.resources.push_back(&_internalResources[${idx}]);`);
      const isTex = r.type === 'texture2d';
      lines.push(`    ctx.isTextureResource.push_back(${isTex});`);
      lines.push(`    ctx.texWidths.push_back(_internalResources[${idx}].width);`);
      lines.push(`    ctx.texHeights.push_back(_internalResources[${idx}].height);`);

      if (r['size'] !== undefined) {
        const sizeExpr = typeof r['size'] === 'number' ? String(r['size']) : '0';
        if (sizeExpr !== '0') {
          lines.push(`    if (_internalResources[${idx}].data.empty()) {`);
          lines.push(`        _internalResources[${idx}].data.resize(${sizeExpr});`);
          lines.push('    }');
        }
      }
    });
    lines.push('}');
    lines.push('#endif');
    lines.push('');



    // Build shader function info for Metal compilation
    // Build shader function info for Metal compilation
    const shaderFunctions: ShaderFunctionInfo[] = Array.from(shaderFuncs.entries()).map(([id, info]) => ({
      id,
      inputs: (info.func.inputs || []).map(i => ({ id: i.id, type: i.type || 'float' })),
      stage: info.stage
    }));

    return {
      code: lines.join('\n'),
      resourceIds,
      shaderFunctions,
    };
  }

  /**
   * Get all resources in the canonical order:
   * 1. Output resources (textures/buffers)
   * 2. Texture inputs (host-provided)
   * 3. Internal resources (scratch buffers/textures)
   */
  private getAllResources(): { id: string, type: string }[] {
    if (!this.ir) return [];
    return [
      ...this.ir.resources.filter(r => r.isOutput),
      ...this.ir.inputs.filter(i => i.type === 'texture2d'),
      ...this.ir.resources.filter(r => !r.isOutput)
    ];
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
  private formatFloat(n: number | boolean): string {
    if (typeof n === 'boolean') return n ? '1.0f' : '0.0f';
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
      case 'float': case 'f32': return 'float';
      case 'int': case 'i32': return 'int';
      case 'uint': case 'u32': return 'unsigned int';
      case 'bool': return 'bool';
      case 'float2': return 'std::array<float, 2>';
      case 'float3': return 'std::array<float, 3>';
      case 'float4': return 'std::array<float, 4>';
      case 'float3x3': return 'std::array<float, 9>';
      case 'float4x4': return 'std::array<float, 16>';
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

  private emitFunction(
    f: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    inferredTypes: Map<string, InferredTypes>
  ) {
    const hasReturn = f.outputs && f.outputs.length > 0;
    const returnType = hasReturn ? 'float' : 'void';
    const params = this.buildFuncParams(f);
    lines.push(`${returnType} ${this.sanitizeId(f.id, 'func')}(EvalContext& ctx${params}) {`);

    // Declare local variables
    for (const v of f.localVars) {
      const cppType = this.irTypeToCpp(v.type || 'float');
      let init: string;
      if (Array.isArray(v.initialValue)) {
        // Vector/array initial value: {0.0f, 0.0f, 0.0f, 0.0f}
        init = `{${(v.initialValue as number[]).map(x => this.formatFloat(x)).join(', ')}}`;
      } else if (typeof v.initialValue === 'number') {
        init = this.formatFloat(v.initialValue);
      } else if (v.initialValue !== undefined) {
        init = String(v.initialValue);
      } else {
        init = '{}';
      }
      lines.push(`    ${cppType} ${this.sanitizeId(v.id, 'var')} = ${init};`);
    }

    const edges = reconstructEdges(f);
    const funcInferred = inferredTypes.get(f.id);


    // Track which pure nodes have been emitted (for auto declarations)
    const emittedPure = new Set<string>();
    const emitPure = (nodeId: string) => {
      if (emittedPure.has(nodeId)) return;
      if (!f || !f.nodes) {
        console.error(`[CPP] emitPure error: f=${!!f} nodes=${f?.nodes ? 'ok' : 'missing'} for nodeId=${nodeId}`);
        throw new Error('FunctionDef invalid in emitPure');
      }
      const node = f.nodes.find(n => n.id === nodeId);
      if (!node || this.isExecutable(node.op, edges, nodeId)) return;

      emittedPure.add(nodeId);

      // Emit dependencies first
      edges.filter(e => e.to === nodeId && e.type === 'data').forEach(edge => {
        emitPure(edge.from);
      });

      // Use auto with inline initialization
      const expr = this.compileExpression(node, f, allFunctions, true, emitPure, edges, funcInferred);
      lines.push(`    auto ${this.nodeResId(node.id)} = ${expr};`);
    };

    // Find entry nodes (executable nodes with no incoming execution edges)
    const entryNodes = f.nodes.filter(n => {
      const hasExecIn = edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op, edges, n.id);
    });

    for (const entry of entryNodes) {
      this.emitChain('    ', entry, f, lines, new Set(), allFunctions, emitPure, edges, funcInferred);
    }

    lines.push('}');
  }

  private hasResult(op: string): boolean {
    const valueOps = [
      'float', 'int', 'uint', 'bool', 'literal', 'loop_index',
      'float2', 'float3', 'float4', 'float3x3', 'float4x4',
      'static_cast_float', 'static_cast_int', 'static_cast_bool',
      'var_get', 'buffer_load', 'vec_swizzle',
      'vec_get_element', 'call_func',
      'struct_construct', 'struct_extract',
      'array_construct', 'array_extract', 'array_length',
      'resource_get_size', 'resource_get_format', 'builtin_get',
      'math_pi', 'math_e',
      'mat_identity', 'mat_mul', 'mat_inverse', 'mat_transpose',
      'quat', 'quat_identity', 'quat_mul', 'quat_rotate', 'quat_slerp', 'quat_to_float4x4',
      'color_mix', 'texture_sample',
    ];
    return valueOps.includes(op) || op.startsWith('math_') || op.startsWith('vec_');
  }

  private isExecutable(op: string, edges: Edge[], nodeId: string): boolean {
    const isSideEffecting = op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'texture_store' || op === 'func_return' || op === 'call_func' || op === 'array_set';

    if (isSideEffecting) return true;

    // A node is also considered "executable" if it has an outgoing execution edge,
    // meaning the user explicitly wants it to be part of the control flow.
    return edges.some(e => e.from === nodeId && e.type === 'execution');
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
    edges: Edge[],
    inferredTypes?: InferredTypes
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
        this.emitBranch(indent, curr, func, lines, visited, allFunctions, emitPure, edges, inferredTypes);
        return;
      } else if (curr.op === 'flow_loop') {
        this.emitLoop(indent, curr, func, lines, visited, allFunctions, emitPure, edges, inferredTypes);
        return;
      } else if (curr.op === 'func_return') {
        // Store return value in context for readback
        const retVal = this.resolveArg(curr, 'val', func, allFunctions, emitPure, edges, inferredTypes);
        const hasReturn = func.outputs && func.outputs.length > 0;
        if (retVal && retVal !== '0.0f') {
          lines.push(`${indent}ctx.setReturnValue(${retVal});`);
          if (hasReturn) {
            lines.push(`${indent}return ${retVal};`);
          } else {
            lines.push(`${indent}return;`);
          }
        } else {
          lines.push(`${indent}return;`);
        }
        return;
      } else {
        this.emitNode(indent, curr, func, lines, allFunctions, emitPure, edges, inferredTypes);
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
    edges: Edge[],
    inferredTypes?: InferredTypes
  ) {
    const cond = this.resolveArg(node, 'cond', func, allFunctions, emitPure, edges, inferredTypes);
    lines.push(`${indent}if (${cond}) {`);
    const trueEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_true' && e.type === 'execution');
    const trueNode = trueEdge ? func.nodes.find(n => n.id === trueEdge.to) : undefined;
    if (trueNode) this.emitChain(indent + '    ', trueNode, func, lines, new Set(visited), allFunctions, emitPure, edges, inferredTypes);
    lines.push(`${indent}} else {`);
    const falseEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_false' && e.type === 'execution');
    const falseNode = falseEdge ? func.nodes.find(n => n.id === falseEdge.to) : undefined;
    if (falseNode) this.emitChain(indent + '    ', falseNode, func, lines, new Set(visited), allFunctions, emitPure, edges, inferredTypes);
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
    edges: Edge[],
    inferredTypes?: InferredTypes
  ) {
    const start = this.resolveArg(node, 'start', func, allFunctions, emitPure, edges, inferredTypes);
    const end = this.resolveArg(node, 'end', func, allFunctions, emitPure, edges, inferredTypes);
    const loopVar = `loop_${node.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    lines.push(`${indent}for (int ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);

    const bodyEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_body' && e.type === 'execution');
    const bodyNode = bodyEdge ? func.nodes.find(n => n.id === bodyEdge.to) : undefined;
    if (bodyNode) this.emitChain(indent + '    ', bodyNode, func, lines, new Set(visited), allFunctions, emitPure, edges, inferredTypes);
    lines.push(`${indent}}`);

    const compEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_completed' && e.type === 'execution');
    const nextNode = compEdge ? func.nodes.find(n => n.id === compEdge.to) : undefined;
    if (nextNode) this.emitChain(indent, nextNode, func, lines, visited, allFunctions, emitPure, edges, inferredTypes);
  }

  private emitNode(
    indent: string,
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    emitPure: (id: string) => void,
    edges: Edge[],
    inferredTypes?: InferredTypes
  ) {
    if (node.op === 'var_set') {
      const val = this.resolveArg(node, 'val', func, allFunctions, emitPure, edges, inferredTypes);
      const varId = node['var'];
      lines.push(`${indent}${this.sanitizeId(varId, 'var')} = ${val};`);
    } else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'];
      const idx = this.resolveArg(node, 'index', func, allFunctions, emitPure, edges, inferredTypes);
      const val = this.resolveArg(node, 'value', func, allFunctions, emitPure, edges, inferredTypes);
      // Find buffer index and data type in resources
      const allRes = this.getAllResources();
      const bufferIdx = allRes.findIndex(r => r.id === bufferId);
      const bufferDef = this.ir?.resources.find(r => r.id === bufferId);
      const dataType = bufferDef?.dataType || 'float';

      // For vector buffers, store the complete vector at the index
      if (dataType === 'float4' || dataType === 'float3' || dataType === 'float2') {
        lines.push(`${indent}ctx.resources[${bufferIdx}]->storeVec(${idx}, ${val});`);
      } else {
        lines.push(`${indent}ctx.resources[${bufferIdx}]->data[static_cast<size_t>(${idx})] = ${val};`);
      }
    } else if (node.op === 'array_set') {
      // (unchanged logic omitted for brevity, but arguments updated)
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
        varName = this.resolveArg(node, 'array', func, allFunctions, emitPure, edges, inferredTypes);
      }
      const idx = this.resolveArg(node, 'index', func, allFunctions, emitPure, edges, inferredTypes);
      const val = this.resolveArg(node, 'value', func, allFunctions, emitPure, edges, inferredTypes);
      lines.push(`${indent}${varName}[static_cast<size_t>(${idx})] = ${val};`);
    } else if (node.op === 'cmd_resize_resource') {
      const resId = node['resource'];
      const allRes = this.getAllResources();
      const resIdx = allRes.findIndex(r => r.id === resId);
      const resDef = this.ir?.resources.find(r => r.id === resId);
      const clearOnResize = resDef?.persistence?.clearOnResize ?? false;
      // Compute element stride from dataType (float4=4, float3=3, float2=2, float=1)
      const dataType = resDef?.dataType;
      const stride = dataType === 'float4' ? 4 : dataType === 'float3' ? 3 : dataType === 'float2' ? 2 : 1;
      const clearVal = node['clear'];
      const sizeVal = node['size'];
      if (Array.isArray(sizeVal) && sizeVal.length === 2) {
        // 2D size [width, height] for textures
        const wExpr = typeof sizeVal[0] === 'number' ? String(sizeVal[0]) : this.resolveArg(node, 'size', func, allFunctions, emitPure, edges, inferredTypes) + '[0]';
        const hExpr = typeof sizeVal[1] === 'number' ? String(sizeVal[1]) : this.resolveArg(node, 'size', func, allFunctions, emitPure, edges, inferredTypes) + '[1]';
        if (Array.isArray(clearVal)) {
          const clearItems = clearVal.map((v: number) => this.formatFloat(v)).join(', ');
          lines.push(`${indent}ctx.resizeResource2DWithClear(${resIdx}, ${wExpr}, ${hExpr}, {${clearItems}});`);
        } else {
          lines.push(`${indent}ctx.resizeResource2D(${resIdx}, ${wExpr}, ${hExpr}, ${clearOnResize ? 'true' : 'false'});`);
        }
      } else {
        const sizeExpr = this.resolveArg(node, 'size', func, allFunctions, emitPure, edges, inferredTypes);
        lines.push(`${indent}ctx.resizeResource(${resIdx}, static_cast<int>(${sizeExpr}), ${stride}, ${clearOnResize ? 'true' : 'false'});`);
      }
    } else if (node.op === 'texture_store') {
      // Texture store is handled by Metal on GPU. CPU fallback is no-op.
    } else if (node.op === 'cmd_dispatch') {
      // Emit dispatch to Metal compute shader
      const targetFunc = node['func'];
      const dispatch = node['dispatch'] || [1, 1, 1];

      // Build dispatch dimensions
      let dimX: string, dimY: string, dimZ: string;
      if (typeof dispatch === 'string') {
        // dispatch is a node reference (e.g., resource_get_size result)
        const dispatchExpr = this.resolveArg(node, 'dispatch', func, allFunctions, emitPure, edges, inferredTypes);
        dimX = `static_cast<int>(${dispatchExpr}[0])`;
        dimY = `static_cast<int>(${dispatchExpr}[1])`;
        dimZ = '1';
      } else if (Array.isArray(dispatch)) {
        dimX = typeof dispatch[0] === 'number' ? String(dispatch[0]) : this.resolveArg({ ...node, dispatch: undefined, ['dispatch_x']: dispatch[0] } as Node, 'dispatch_x', func, allFunctions, emitPure, edges, inferredTypes);
        dimY = typeof dispatch[1] === 'number' ? String(dispatch[1]) : this.resolveArg({ ...node, dispatch: undefined, ['dispatch_y']: dispatch[1] } as Node, 'dispatch_y', func, allFunctions, emitPure, edges, inferredTypes);
        dimZ = typeof dispatch[2] === 'number' ? String(dispatch[2]) : this.resolveArg({ ...node, dispatch: undefined, ['dispatch_z']: dispatch[2] } as Node, 'dispatch_z', func, allFunctions, emitPure, edges, inferredTypes);
      } else {
        dimX = '1'; dimY = '1'; dimZ = '1';
      }

      // Build args - serialize all inputs as flat floats for GPU marshalling
      const targetFuncDef = allFunctions.find(f => f.id === targetFunc);
      const hasExplicitInputs = targetFuncDef?.inputs && targetFuncDef.inputs.length > 0;

      // If shader has no explicit inputs but IR has global inputs, serialize those
      const hasGlobalInputs = !hasExplicitInputs && this.ir?.inputs && this.ir.inputs.length > 0;

      // Collect CPU-allowed builtins used by the target shader
      const shaderAnalysis = this.functionAnalysis.get(targetFunc);
      const usedBuiltins = shaderAnalysis ? [...shaderAnalysis.usedBuiltins].filter(b => BUILTIN_CPU_ALLOWED.includes(b)) : [];

      if (hasExplicitInputs || usedBuiltins.length > 0) {
        lines.push(`${indent}{`);
        lines.push(`${indent}    std::vector<float> _shader_args;`);

        if (hasExplicitInputs) {
          for (const input of targetFuncDef!.inputs!) {
            let argExpr: string;
            if (node['args'] && node['args'][input.id]) {
              const argId = node['args'][input.id];
              argExpr = this.resolveArg({ ...node, [input.id]: argId } as Node, input.id, func, allFunctions, emitPure, edges, inferredTypes);
            } else if (node[input.id] !== undefined) {
              argExpr = this.resolveArg(node, input.id, func, allFunctions, emitPure, edges, inferredTypes);
            } else {
              argExpr = '0.0f';
            }

            const irType = input.type || 'float';
            this.emitArgFlattening(`${indent}    `, argExpr, irType, lines);
          }
        }

        // Inject CPU-allowed builtins used by the shader
        for (const b of usedBuiltins) {
          lines.push(`${indent}    _shader_args.push_back(ctx.getInput("${b}"));`);
        }

        lines.push(`${indent}    ctx.dispatchShader("${targetFunc}", ${dimX}, ${dimY}, ${dimZ}, _shader_args);`);
        lines.push(`${indent}}`);
      } else if (hasGlobalInputs) {
        // Serialize IR global inputs into args buffer for the shader
        lines.push(`${indent}{`);
        lines.push(`${indent}    std::vector<float> _shader_args;`);

        for (const input of this.ir!.inputs!) {
          const irType = input.type || 'float';
          // Use flattened global inputs (e.g. "u_color_tint_0", "u_color_tint_1")
          this.emitGlobalInputFlattening(`${indent}    `, input.id, irType, lines, []);
        }

        lines.push(`${indent}    ctx.dispatchShader("${targetFunc}", ${dimX}, ${dimY}, ${dimZ}, _shader_args);`);
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}ctx.dispatchShader("${targetFunc}", ${dimX}, ${dimY}, ${dimZ});`);
      }
    } else if (node.op === 'cmd_draw') {
      const target = node['target'];
      const vertex = node['vertex'];
      const fragment = node['fragment'];
      const count = this.resolveArg(node, 'count', func, allFunctions, emitPure, edges, inferredTypes);

      const allRes = this.getAllResources();
      const targetIdx = allRes.findIndex(r => r.id === target);

      lines.push(`${indent}ctx.draw(${targetIdx}, "${vertex}", "${fragment}", static_cast<int>(${count}));`);
    } else if (this.hasResult(node.op)) {
      // Executable nodes with results (like call_func) need auto declarations
      const expr = this.compileExpression(node, func, allFunctions, true, emitPure, edges, inferredTypes);
      lines.push(`${indent}auto ${this.nodeResId(node.id)} = ${expr};`);
    }
  }

  private resolveArg(
    node: Node,
    key: string,
    func: FunctionDef,
    allFunctions: FunctionDef[],
    emitPure: (id: string) => void,
    edges: Edge[],
    inferredTypes?: InferredTypes
  ): string {
    const edge = edges.find(e => e.to === node.id && (e.portIn === key || (key === 'val' && e.portIn === 'value')) && e.type === 'data');
    if (edge) {
      const source = func.nodes.find(n => n.id === edge.from);
      if (source) return this.compileExpression(source, func, allFunctions, false, emitPure, edges, inferredTypes);
    }

    let val: any = node[key];

    if (val !== undefined) {
      if (typeof val === 'string') {
        if (func.localVars.some(v => v.id === val)) return this.sanitizeId(val, 'var');
        if (func.inputs.some(i => i.id === val)) return this.sanitizeId(val, 'input');
        // Check IR global inputs (input inheritance)
        if (this.ir?.inputs?.some(i => i.id === val)) {
          const varId = val;
          const inputDef = this.ir.inputs.find(i => i.id === varId)!;
          if (inputDef.type === 'float2') {
            return `std::array<float, 2>{ctx.getInput("${varId}_0"), ctx.getInput("${varId}_1")}`;
          }
          if (inputDef.type === 'float3') {
            return `std::array<float, 3>{ctx.getInput("${varId}_0"), ctx.getInput("${varId}_1"), ctx.getInput("${varId}_2")}`;
          }
          if (inputDef.type === 'float4') {
            return `std::array<float, 4>{ctx.getInput("${varId}_0"), ctx.getInput("${varId}_1"), ctx.getInput("${varId}_2"), ctx.getInput("${varId}_3")}`;
          }
          if (inputDef.type === 'float4x4') {
            const items = Array.from({ length: 16 }, (_, i) => `ctx.getInput("${varId}_${i}")`);
            return `std::array<float, 16>{${items.join(', ')}}`;
          }
          if (inputDef.type === 'float3x3') {
            const items = Array.from({ length: 9 }, (_, i) => `ctx.getInput("${varId}_${i}")`);
            return `std::array<float, 9>{${items.join(', ')}}`;
          }
          return `ctx.getInput("${varId}")`;
        }
        const targetNode = func.nodes.find(n => n.id === val);
        if (targetNode && targetNode.id !== node.id) {
          return this.compileExpression(targetNode, func, allFunctions, false, emitPure, edges, inferredTypes);
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

  private resolveCoercedArgs(
    node: Node,
    keys: string[],
    mode: 'float' | 'unify',
    func: FunctionDef,
    allFunctions: FunctionDef[],
    emitPure: (id: string) => void,
    edges: Edge[],
    inferredTypes?: InferredTypes
  ): string[] {
    const rawArgs = keys.map(k => this.resolveArg(node, k, func, allFunctions, emitPure, edges, inferredTypes));

    if (!inferredTypes) return rawArgs;

    const argTypes = keys.map(k => {
      const argId = node[k];
      return typeof argId === 'string' ? inferredTypes.get(argId) || 'float' : 'float';
    });

    if (isCppDebugEnabled()) {
      console.log(`[CPP] resolveCoercedArgs op=${node.op} keys=${keys} types=${argTypes} mode=${mode}`);
    }

    if (mode === 'float') {
      return rawArgs.map((arg, i) => {
        const type = argTypes[i];
        if (type === 'int' || type === 'uint' || type === 'boolean') {
          return `static_cast<float>(${arg})`;
        }
        return arg;
      });
    } else if (mode === 'unify') {
      const hasFloat = argTypes.some(t => t.includes('float'));
      if (hasFloat) {
        return rawArgs.map((arg, i) => {
          const type = argTypes[i];
          if (type === 'int' || type === 'uint' || type === 'boolean') {
            return `static_cast<float>(${arg})`;
          }
          return arg;
        });
      }
    }
    return rawArgs;
  }

  private compileExpression(
    node: Node,
    func: FunctionDef,
    allFunctions: FunctionDef[],
    forceEmit: boolean,
    emitPure: (id: string) => void,
    edges: Edge[],
    inferredTypes?: InferredTypes
  ): string {
    if (!forceEmit && this.hasResult(node.op)) {
      emitPure(node.id);
      return this.nodeResId(node.id);
    }

    const a = (key = 'a') => this.resolveArg(node, key, func, allFunctions, emitPure, edges, inferredTypes);
    const b = (key = 'b') => this.resolveArg(node, key, func, allFunctions, emitPure, edges, inferredTypes);
    const val = (key = 'val') => this.resolveArg(node, key, func, allFunctions, emitPure, edges, inferredTypes);

    // Helper for simple binary/unary ops using coercion
    const binaryOp = (op: string, mode: 'float' | 'unify') => {
      const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], mode, func, allFunctions, emitPure, edges, inferredTypes);
      return `${argA} ${op} ${argB}`;
    };

    const unaryOp = (op: string, mode: 'float' | 'unify', key = 'val') => {
      const [arg] = this.resolveCoercedArgs(node, [key], mode, func, allFunctions, emitPure, edges, inferredTypes);
      return `${op}(${arg})`;
    };

    switch (node.op) {
      case 'var_get': {
        const varId = node['var'];
        if (func.localVars.some(v => v.id === varId)) return this.sanitizeId(varId, 'var');
        if (func.inputs.some(i => i.id === varId)) return this.sanitizeId(varId, 'input');
        if (this.ir?.inputs?.some(i => i.id === varId)) {
          const inputDef = this.ir.inputs.find(i => i.id === varId)!;
          if (inputDef.type === 'float2') {
            return `std::array<float, 2>{ctx.getInput("${varId}_0"), ctx.getInput("${varId}_1")}`;
          }
          if (inputDef.type === 'float3') {
            return `std::array<float, 3>{ctx.getInput("${varId}_0"), ctx.getInput("${varId}_1"), ctx.getInput("${varId}_2")}`;
          }
          if (inputDef.type === 'float4') {
            return `std::array<float, 4>{ctx.getInput("${varId}_0"), ctx.getInput("${varId}_1"), ctx.getInput("${varId}_2"), ctx.getInput("${varId}_3")}`;
          }
          if (inputDef.type === 'float4x4') {
            // 16 floats
            const items = Array.from({ length: 16 }, (_, i) => `ctx.getInput("${varId}_${i}")`);
            return `std::array<float, 16>{${items.join(', ')}}`;
          }
          if (inputDef.type === 'float3x3') {
            const items = Array.from({ length: 9 }, (_, i) => `ctx.getInput("${varId}_${i}")`);
            return `std::array<float, 9>{${items.join(', ')}}`;
          }
          // Array types? "float[]" -> logic needed?
          return `ctx.getInput("${varId}")`;
        }
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
        const allRes = this.getAllResources();
        const bufferIdx = allRes.findIndex(r => r.id === bufferId);
        return `ctx.resources[${bufferIdx}]->data[static_cast<size_t>(${idx})]`;
      }

      // Constants
      case 'math_pi': return '3.14159265358979323846f';
      case 'math_e': return '2.71828182845904523536f';

      // Math ops - inlined for simpler code
      case 'math_neg': return `(-(${val()}))`;
      case 'math_abs': return unaryOp('abs', 'unify');
      case 'math_sign': return `applyUnary(${val()}, [](float x) -> float { return x > 0.0f ? 1.0f : (x < 0.0f ? -1.0f : 0.0f); })`;
      case 'math_sin': return unaryOp('sin', 'float');
      case 'math_cos': return unaryOp('cos', 'float');
      case 'math_tan': return unaryOp('tan', 'float');
      case 'math_asin': return unaryOp('asin', 'float');
      case 'math_acos': return unaryOp('acos', 'float');
      case 'math_atan': return unaryOp('atan', 'float');
      case 'math_sinh': return unaryOp('sinh', 'float');
      case 'math_cosh': return unaryOp('cosh', 'float');
      case 'math_tanh': return unaryOp('tanh', 'float');
      case 'math_sqrt': return unaryOp('sqrt', 'float');
      case 'math_exp': return unaryOp('exp', 'float');
      case 'math_exp2': return unaryOp('exp2', 'float');
      case 'math_log': return unaryOp('log', 'float');
      case 'math_log2': return unaryOp('log2', 'float');
      case 'math_ceil': return unaryOp('ceil', 'float');
      case 'math_floor': return unaryOp('floor', 'float');
      case 'math_round': return unaryOp('round', 'float');
      case 'math_trunc': return unaryOp('trunc', 'float');
      case 'math_fract': { const v = unaryOp('', 'float', 'val'); return `((${v}) - floor(${v}))`; }

      case 'math_add': return `(${binaryOp('+', 'unify')})`;
      case 'math_sub': return `(${binaryOp('-', 'unify')})`;
      case 'math_mul': return `(${binaryOp('*', 'unify')})`;
      case 'math_div': return `(${binaryOp('/', 'unify')})`;
      case 'math_mod': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `fmod(${argA}, ${argB})`; }
      case 'math_pow': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'float', func, allFunctions, emitPure, edges, inferredTypes); return `pow(${argA}, ${argB})`; }
      case 'math_min': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `std::min(${argA}, ${argB})`; }
      case 'math_max': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `std::max(${argA}, ${argB})`; }
      case 'math_atan2': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'float', func, allFunctions, emitPure, edges, inferredTypes); return `atan2(${argA}, ${argB})`; }
      case 'math_step': { const [edge, v] = this.resolveCoercedArgs(node, ['edge', 'val'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `((${v}) >= (${edge}) ? 1.0f : 0.0f)`; }
      case 'math_smoothstep': {
        const [e0, e1, v] = this.resolveCoercedArgs(node, ['edge0', 'edge1', 'val'], 'unify', func, allFunctions, emitPure, edges, inferredTypes);
        return `clamp_val(((${v}) - (${e0})) / ((${e1}) - (${e0})), 0.0f, 1.0f) * (clamp_val(((${v}) - (${e0})) / ((${e1}) - (${e0})), 0.0f, 1.0f) * (3.0f - 2.0f * clamp_val(((${v}) - (${e0})) / ((${e1}) - (${e0})), 0.0f, 1.0f)))`;
      }

      case 'math_mix':
      case 'math_lerp': {
        const [argA, argB, argT] = this.resolveCoercedArgs(node, ['a', 'b', 't'], 'unify', func, allFunctions, emitPure, edges, inferredTypes);
        return `([](auto a_, auto b_, auto t_) { return a_ + (b_ - a_) * t_; }(${argA}, ${argB}, ${argT}))`;
      }
      case 'math_clamp': {
        const [val, min, max] = this.resolveCoercedArgs(node, ['val', 'min', 'max'], 'unify', func, allFunctions, emitPure, edges, inferredTypes);
        return `clamp_val(${val}, ${min}, ${max})`;
      }
      case 'math_mad': {
        const [argA, argB, argC] = this.resolveCoercedArgs(node, ['a', 'b', 'c'], 'unify', func, allFunctions, emitPure, edges, inferredTypes);
        return `((${argA}) * (${argB}) + (${argC}))`;
      }
      case 'math_select': {
        const cond = this.resolveArg(node, 'cond', func, allFunctions, emitPure, edges, inferredTypes);
        // resolveCoercedArgs for 'true' and 'false' branches to unify them?
        const [t, f] = this.resolveCoercedArgs(node, ['true', 'false'], 'unify', func, allFunctions, emitPure, edges, inferredTypes);
        return `((${cond}) != 0.0f ? (${t}) : (${f}))`;
      }

      // Comparisons
      case 'math_gt': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `applyBinary(${argA}, ${argB}, [](float x, float y) -> float { return x > y ? 1.0f : 0.0f; })`; }
      case 'math_lt': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `applyBinary(${argA}, ${argB}, [](float x, float y) -> float { return x < y ? 1.0f : 0.0f; })`; }
      case 'math_ge':
      case 'math_gte': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `applyBinary(${argA}, ${argB}, [](float x, float y) -> float { return x >= y ? 1.0f : 0.0f; })`; }
      case 'math_le':
      case 'math_lte': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `applyBinary(${argA}, ${argB}, [](float x, float y) -> float { return x <= y ? 1.0f : 0.0f; })`; }
      case 'math_eq': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `applyBinary(${argA}, ${argB}, [](float x, float y) -> float { return x == y ? 1.0f : 0.0f; })`; }
      case 'math_neq': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `applyBinary(${argA}, ${argB}, [](float x, float y) -> float { return x != y ? 1.0f : 0.0f; })`; }

      // Logic
      case 'math_and': return `((${a()}) != 0.0f && (${b()}) != 0.0f ? 1.0f : 0.0f)`;
      case 'math_or': return `((${a()}) != 0.0f || (${b()}) != 0.0f ? 1.0f : 0.0f)`;
      case 'math_xor': return `(((${a()}) != 0.0f) != ((${b()}) != 0.0f) ? 1.0f : 0.0f)`;
      case 'math_not': return `((${val()}) == 0.0f ? 1.0f : 0.0f)`;

      // Numeric analysis
      case 'math_is_nan': return `applyUnary(${val()}, [](float x) -> float { return std::isnan(x) ? 1.0f : 0.0f; })`;
      case 'math_is_inf': return `applyUnary(${val()}, [](float x) -> float { return std::isinf(x) ? 1.0f : 0.0f; })`;
      case 'math_is_finite': return `applyUnary(${val()}, [](float x) -> float { return std::isfinite(x) ? 1.0f : 0.0f; })`;

      // Helper functions for vectors
      case 'vec_dot': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `dot(${argA}, ${argB})`; }
      case 'vec_cross': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `cross(${argA}, ${argB})`; }
      case 'vec_length': return `length(${a()})`;
      case 'vec_distance': { const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `distance(${argA}, ${argB})`; }
      case 'vec_normalize': return `normalize(${a()})`;
      case 'vec_faceforward': { const [n, i, nRef] = this.resolveCoercedArgs(node, ['N', 'I', 'Nref'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `faceforward(${n}, ${i}, ${nRef})`; }
      case 'vec_reflect': { const [i, n] = this.resolveCoercedArgs(node, ['I', 'N'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `reflect(${i}, ${n})`; }
      case 'vec_refract': { const [i, n, eta] = this.resolveCoercedArgs(node, ['I', 'N', 'eta'], 'unify', func, allFunctions, emitPure, edges, inferredTypes); return `refract(${i}, ${n}, ${eta})`; }

      case 'math_mantissa': {
        const v = val(); return `([](float x) { int e; return std::frexp(x, &e); }(${v}))`;
      }
      case 'math_exponent': {
        const v = val(); return `([](float x) { int e; std::frexp(x, &e); return static_cast<float>(e); }(${v}))`;
      }
      case 'math_flush_subnormal': {
        const v = val(); return `([](float x) { return std::fpclassify(x) == FP_SUBNORMAL ? 0.0f : x; }(${v}))`;
      }

      case 'float': return `static_cast<float>(${val()})`;
      case 'int': return `static_cast<int>(${val()})`;
      case 'bool': {
        const v = node['val'];
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        return `(${val()} != 0.0f)`;
      }
      case 'static_cast_float': return `static_cast<float>(${val()})`;
      case 'static_cast_int': return `static_cast<int>(static_cast<int32_t>(static_cast<int64_t>(${val()})))`;
      case 'static_cast_bool': return `((${val()}) != 0.0f ? 1.0f : 0.0f)`;

      case 'float2': return `std::array<float, 2>{${a('x')}, ${a('y')}}`;
      case 'float3': return `std::array<float, 3>{${a('x')}, ${a('y')}, ${a('z')}}`;
      case 'float4': return `std::array<float, 4>{${a('x')}, ${a('y')}, ${a('z')}, ${a('w')}}`;

      case 'float3x3': {
        const vals = node['vals'];
        if (typeof vals === 'string') {
          // Node reference - resolve to expression (already an std::array<float, 9>)
          return this.resolveArg(node, 'vals', func, allFunctions, emitPure, edges);
        }
        const items = ((vals || []) as number[]).map((v: number) => this.formatFloat(v));
        return `std::array<float, 9>{${items.join(', ')}}`;
      }
      case 'float4x4': {
        const vals = node['vals'];
        if (typeof vals === 'string') {
          // Node reference - resolve to expression (already an std::array<float, 16>)
          return this.resolveArg(node, 'vals', func, allFunctions, emitPure, edges);
        }
        const items = ((vals || []) as number[]).map((v: number) => this.formatFloat(v));
        return `std::array<float, 16>{${items.join(', ')}}`;
      }

      case 'vec_mix': {
        const [argA, argB, argT] = this.resolveCoercedArgs(node, ['a', 'b', 't'], 'unify', func, allFunctions, emitPure, edges, inferredTypes);
        return `vec_mix_impl(${argA}, ${argB}, ${argT})`;
      }

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

      // Color
      case 'color_mix': {
        const dst = a(); const src = b();
        return `([](std::array<float, 4> d, std::array<float, 4> s) -> std::array<float, 4> {
          float sa = s[3], da = d[3];
          float ra = sa + da * (1.0f - sa);
          if (ra < 1e-6f) return {0.0f, 0.0f, 0.0f, 0.0f};
          return {(s[0]*sa + d[0]*da*(1.0f-sa))/ra, (s[1]*sa + d[1]*da*(1.0f-sa))/ra, (s[2]*sa + d[2]*da*(1.0f-sa))/ra, ra};
        }(${dst}, ${src}))`;
      }

      // Matrices
      case 'mat_identity': {
        const size = node['size'] as number || 4;
        if (size === 3) return `std::array<float, 9>{1,0,0, 0,1,0, 0,0,1}`;
        return `std::array<float, 16>{1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1}`;
      }
      case 'mat_mul': {
        const ma = a(); const mb = b();
        return `mat_mul(${ma}, ${mb})`;
      }
      case 'mat_inverse': return `${val()}`; // Placeholder: returns input unchanged (matches reference impl)
      case 'mat_transpose': return `mat_transpose(${val()})`;

      // Quaternions
      case 'quat': {
        return `std::array<float, 4>{${a('x')}, ${a('y')}, ${a('z')}, ${a('w')}}`;
      }
      case 'quat_identity': return `std::array<float, 4>{0.0f, 0.0f, 0.0f, 1.0f}`;
      case 'quat_mul': return `quat_mul(${a()}, ${b()})`;
      case 'quat_rotate': return `quat_rotate(${a('q')}, ${a('v')})`;
      case 'quat_slerp': return `quat_slerp(${a()}, ${b()}, ${a('t')})`;
      case 'quat_to_float4x4': return `quat_to_float4x4(${a('q')})`;

      // Texture sampling (CPU-side sampling from resource data)
      case 'texture_sample': {
        const texId = node['tex'] as string;
        const resIdx = this.ir?.resources.findIndex(r => r.id === texId) ?? -1;
        const resDef = this.ir?.resources.find(r => r.id === texId);
        const sampler = (resDef as any)?.sampler;
        const wrapMap: Record<string, number> = { 'repeat': 0, 'clamp': 1, 'mirror': 2 };
        const filterMap: Record<string, number> = { 'nearest': 0, 'linear': 1 };
        const wrapMode = wrapMap[sampler?.wrap ?? 'clamp'] ?? 1;
        const filterMode = filterMap[sampler?.filter ?? 'nearest'] ?? 0;
        const fmt = resDef?.format;
        const elemStride = (fmt === 'r32f' || fmt === 'r16f' || fmt === 'r8') ? 1 : 4;
        const coordsExpr = this.resolveArg(node, 'coords', func, allFunctions, emitPure, edges);
        return `ctx.sampleTexture(${resIdx}, ${coordsExpr}[0], ${coordsExpr}[1], ${wrapMode}, ${filterMode}, ${elemStride})`;
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
        const values = node['values'];
        const length = Array.isArray(values) ? values.length : (node['length'] || 0);
        const fill = node['fill'];
        let elemType: string | undefined;

        if (inferredTypes) {
          const nodeType = inferredTypes.get(node.id);
          if (nodeType) {
            if (nodeType === 'float2' || nodeType === 'float3' || nodeType === 'float4') {
              elemType = 'float';
            } else {
              const match = nodeType.match(/array<([^,]+),/);
              if (match) {
                elemType = this.irTypeToCpp(match[1]);
              }
            }
          }
        }

        if (Array.isArray(values)) {
          const items = values.map((val, i) => {
            if (typeof val === 'number') {
              if (elemType === 'float' || !elemType) {
                if (!elemType) elemType = 'float';
                return this.formatFloat(val);
              }
              if (elemType === 'int') return String(Math.floor(val));
              return String(val);
            }
            if (typeof val === 'string') {
              // Node reference
              emitPure(val);
              const resId = this.nodeResId(val);
              if (!elemType) elemType = `decltype(${resId})`;
              return resId;
            }
            return String(val);
          });
          if (!elemType) elemType = 'float';
          return `std::array<${elemType}, ${length}>{${items.join(', ')}}`;
        }

        let fillExpr: string;
        if (fill === undefined) {
          fillExpr = '0.0f';
          if (!elemType) elemType = 'float';
        } else if (typeof fill === 'number') {
          if (elemType === 'float') {
            fillExpr = this.formatFloat(fill);
          } else if (elemType === 'int') {
            fillExpr = String(Math.floor(fill));
          } else {
            // Fallback if no elemType inferred
            if (Number.isInteger(fill)) {
              fillExpr = String(fill);
              elemType = 'int';
            } else {
              fillExpr = this.formatFloat(fill);
              elemType = 'float';
            }
          }
        } else if (typeof fill === 'string') {
          // Could be a node reference
          const refNode = func.nodes.find(n => n.id === fill);
          if (refNode) {
            emitPure(fill);
            fillExpr = this.nodeResId(fill);
            if (!elemType) elemType = `decltype(${fillExpr})`;
          } else if (func.localVars.some(v => v.id === fill)) {
            fillExpr = this.sanitizeId(fill, 'var');
            if (!elemType) elemType = `decltype(${fillExpr})`;
          } else {
            fillExpr = fill;
            if (!elemType) elemType = 'float';
          }
        } else {
          fillExpr = String(fill);
          if (!elemType) elemType = 'float';
        }

        return `({auto _arr = std::array<${elemType}, ${length}>{}; for(auto& _e : _arr) _e = ${fillExpr}; _arr;})`;
      }

      case 'array_extract': {
        const arrExpr = this.resolveArg(node, 'array', func, allFunctions, emitPure, edges);
        const idx = this.resolveArg(node, 'index', func, allFunctions, emitPure, edges);
        return `${arrExpr}[static_cast<size_t>(${idx})]`;
      }

      case 'array_length': {
        const arrExpr = this.resolveArg(node, 'array', func, allFunctions, emitPure, edges);
        return `static_cast<int>(${arrExpr}.size())`;
      }

      case 'resource_get_size': {
        const resId = node['resource'];
        const allRes = this.getAllResources();
        const resIdx = allRes.findIndex(r => r.id === resId);
        return `std::array<float, 2>{static_cast<float>(ctx.resources[${resIdx}]->width), static_cast<float>(ctx.resources[${resIdx}]->height)}`;
      }

      case 'resource_get_format': {
        const resId = node['resource'];
        const resDef = this.ir?.resources.find(r => r.id === resId);
        const formatMap: Record<string, number> = {
          'unknown': 0, 'rgba8': 1, 'rgba16f': 2, 'rgba32f': 3,
          'r8': 4, 'r16f': 5, 'r32f': 6,
        };
        const fmt = resDef?.format ?? 'rgba8';
        const fmtId = formatMap[fmt] ?? 0;
        return `${this.formatFloat(fmtId)}`;
      }

      case 'builtin_get': {
        const name = node['name'] as string;
        if (BUILTIN_CPU_ALLOWED.includes(name)) {
          return `ctx.getInput("${name}")`;
        }
        throw new Error(`C++ Generator: GPU Built-in '${name}' is not available in CPU context`);
      }

      default:
        throw new Error(`C++ Generator: Unsupported op '${node.op}'`);
    }
  }

  private emitGlobalInputFlattening(indent: string, inputId: string, irType: string, lines: string[], keys: string[] = []) {
    // Helper to flatten vector/matrix inputs for global inputs
    // For global inputs, we expect flattened keys in ctx.inputs (e.g. "u_color_tint_0")

    // Check for fixed array: array<T, N>
    const arrayMatch = irType.match(/^array<([^,]+),\s*(\d+)>$/);
    if (arrayMatch) {
      const elemType = arrayMatch[1];
      const len = parseInt(arrayMatch[2]);
      for (let i = 0; i < len; i++) {
        this.emitGlobalInputFlattening(indent, inputId, elemType, lines, [...keys, String(i)]);
      }
      return;
    }

    // Basic types
    const emitPush = (suffix: string) => {
      const key = keys.length > 0 ? `${inputId}_${keys.join('_')}${suffix}` : `${inputId}${suffix}`;
      lines.push(`${indent}_shader_args.push_back(ctx.getInput("${key}"));`);
    };

    if (irType === 'float4') {
      emitPush('_0'); emitPush('_1'); emitPush('_2'); emitPush('_3');
    } else if (irType === 'float3') {
      emitPush('_0'); emitPush('_1'); emitPush('_2');
    } else if (irType === 'float2') {
      emitPush('_0'); emitPush('_1');
    } else if (irType === 'float4x4') {
      for (let i = 0; i < 16; i++) emitPush(`_${i}`);
    } else if (irType === 'float3x3') {
      for (let i = 0; i < 9; i++) emitPush(`_${i}`);
    } else {
      // Scalar or unknown, just use base ID (or with accumulated keys)
      const key = keys.length > 0 ? `${inputId}_${keys.join('_')}` : inputId;
      lines.push(`${indent}_shader_args.push_back(ctx.getInput("${key}"));`);
    }
  }

  /**
   * Emit code to flatten a C++ expression of a given IR type into _shader_args vector.
   * Handles scalars, vectors, matrices, structs, and arrays recursively.
   */
  private emitArgFlattening(indent: string, argExpr: string, irType: string, lines: string[]) {
    // Helper to flatten vector/matrix types into float array for shader args
    const structDef = this.ir?.structs?.find(s => s.id === irType);
    if (structDef) {
      // Struct - flatten each member
      for (const member of structDef.members) {
        this.emitArgFlattening(indent, `${argExpr}.${this.sanitizeId(member.name, 'field')}`, member.type, lines);
      }
      return;
    }

    // Check for fixed array: array<T, N> (allow optional space)
    const arrayMatch = irType.match(/^array<([^,]+),\s*(\d+)>$/);
    if (arrayMatch) {
      const elemType = arrayMatch[1];
      const len = parseInt(arrayMatch[2]);
      for (let i = 0; i < len; i++) {
        this.emitArgFlattening(indent, `${argExpr}[${i}]`, elemType, lines);
      }
      return;
    }

    // Dynamic array: T[] (e.g. "float[]" or "Point[]")
    const dynMatch = irType.match(/^(.+)\[\]$/);
    if (dynMatch) {
      const elemType = dynMatch[1];
      // 1. Push length
      lines.push(`${indent}_shader_args.push_back(static_cast<float>(${argExpr}.size()));`);
      // 2. Push elements
      lines.push(`${indent}for (const auto& elem : ${argExpr}) {`);
      this.emitArgFlattening(`${indent}  `, 'elem', elemType, lines);
      lines.push(`${indent}}`);
      return;
    }

    // Dynamic array via array<T> is treated as T[]
    const legacyDynMatch = irType.match(/^array<(.+)>$/);
    if (legacyDynMatch) {
      const elemType = legacyDynMatch[1];
      lines.push(`${indent}_shader_args.push_back(static_cast<float>(${argExpr}.size()));`);
      lines.push(`${indent}for (const auto& elem : ${argExpr}) {`);
      this.emitArgFlattening(`${indent}  `, 'elem', elemType, lines);
      lines.push(`${indent}}`);
      return;
    }

    // Basic types
    if (irType === 'float4') {
      lines.push(`${indent}_shader_args.push_back(${argExpr}[0]);`);
      lines.push(`${indent}_shader_args.push_back(${argExpr}[1]);`);
      lines.push(`${indent}_shader_args.push_back(${argExpr}[2]);`);
      lines.push(`${indent}_shader_args.push_back(${argExpr}[3]);`);
    } else if (irType === 'float3') {
      lines.push(`${indent}_shader_args.push_back(${argExpr}[0]);`);
      lines.push(`${indent}_shader_args.push_back(${argExpr}[1]);`);
      lines.push(`${indent}_shader_args.push_back(${argExpr}[2]);`);
    } else if (irType === 'float2') {
      lines.push(`${indent}_shader_args.push_back(${argExpr}[0]);`);
      lines.push(`${indent}_shader_args.push_back(${argExpr}[1]);`);
    } else if (irType === 'float4x4') {
      // Flatten 4x4 matrix (16 floats)
      for (let i = 0; i < 16; i++) {
        lines.push(`${indent}_shader_args.push_back(${argExpr}[${i}]);`);
      }
    } else if (irType === 'float3x3') {
      // Flatten 3x3 matrix (9 floats)
      for (let i = 0; i < 9; i++) {
        lines.push(`${indent}_shader_args.push_back(${argExpr}[${i}]);`);
      }
    } else if (irType === 'int' || irType === 'uint' || irType === 'boolean') {
      lines.push(`${indent}_shader_args.push_back(static_cast<float>(${argExpr}));`);
    } else {
      // float or unknown
      lines.push(`${indent}_shader_args.push_back(${argExpr});`);
    }
  }
}
