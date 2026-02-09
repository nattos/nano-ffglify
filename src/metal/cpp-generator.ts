/**
 * C++ Code Generator for IR execution
 * Generates standalone C++ code from IR, modeled after cpu-jit.ts
 */

import { IRDocument, FunctionDef, Node, Edge } from '../ir/types';
import { reconstructEdges } from '../ir/utils';

export interface ShaderFunctionInfo {
  id: string;
  inputs: { id: string; type: string }[];
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
    const shaderFuncs = new Map<string, FunctionDef>();

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
              shaderFuncs.set(targetFunc, shaderFunc);
            }
          }
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

    // FFGL Plugin Helpers (guarded - only compiled when PLUGIN_CLASS is defined)
    lines.push('#ifdef PLUGIN_CLASS');
    lines.push('void PLUGIN_CLASS::init_plugin() {');
    const params = ir.inputs.filter(i => i.type !== 'texture2d');
    params.forEach((p, idx) => {
      const label = p.label || p.id;
      const def = p.default !== undefined ? p.default : 0.5;
      lines.push(`    SetParamInfo(${idx}, "${label}", FF_TYPE_STANDARD, ${this.formatFloat(def)});`);
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
    lines.push('#endif');
    lines.push('');

    lines.push('void PLUGIN_CLASS::setup_resources(EvalContext& ctx, ResourceState* outputRes, const std::vector<ResourceState*>& inputRes) {');
    lines.push('    // 1. Outputs first');
    lines.push('    ctx.resources.push_back(outputRes);');
    lines.push('');
    lines.push('    // 2. Texture inputs second');
    lines.push('    for (auto* res : inputRes) {');
    lines.push('        ctx.resources.push_back(res);');
    lines.push('    }');
    lines.push('');
    lines.push('    // 3. Other internal resources last');
    const internalRes = ir.resources.filter(r => !r.isOutput);
    internalRes.forEach((r, idx) => {
      lines.push(`    ctx.resources.push_back(&_internalResources[${idx}]);`);
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
    lines.push('');



    // Build shader function info for Metal compilation
    const shaderFunctions: ShaderFunctionInfo[] = Array.from(shaderFuncs.entries()).map(([id, func]) => ({
      id,
      inputs: (func.inputs || []).map(i => ({ id: i.id, type: i.type || 'float' }))
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

  private emitFunction(f: FunctionDef, lines: string[], allFunctions: FunctionDef[]) {
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
      'float2', 'float3', 'float4', 'float3x3', 'float4x4',
      'static_cast_float', 'static_cast_int', 'static_cast_bool',
      'var_get', 'buffer_load', 'vec_swizzle',
      'vec_get_element', 'call_func',
      'struct_construct', 'struct_extract',
      'array_construct', 'array_extract', 'array_length',
      'resource_get_size', 'resource_get_format',
      'math_pi', 'math_e',
      'mat_identity', 'mat_mul', 'mat_inverse', 'mat_transpose',
      'quat', 'quat_identity', 'quat_mul', 'quat_rotate', 'quat_slerp', 'quat_to_float4x4',
      'color_mix', 'texture_sample',
    ];
    return valueOps.includes(op) || op.startsWith('math_') || op.startsWith('vec_');
  }

  private isExecutable(op: string): boolean {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'texture_store' || op === 'func_return' || op === 'call_func' || op === 'array_set';
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
        // Store return value in context for readback
        const retVal = this.resolveArg(curr, 'val', func, allFunctions, emitPure, edges);
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
        const wExpr = typeof sizeVal[0] === 'number' ? String(sizeVal[0]) : this.resolveArg(node, 'size', func, allFunctions, emitPure, edges) + '[0]';
        const hExpr = typeof sizeVal[1] === 'number' ? String(sizeVal[1]) : this.resolveArg(node, 'size', func, allFunctions, emitPure, edges) + '[1]';
        if (Array.isArray(clearVal)) {
          const clearItems = clearVal.map((v: number) => this.formatFloat(v)).join(', ');
          lines.push(`${indent}ctx.resizeResource2DWithClear(${resIdx}, ${wExpr}, ${hExpr}, {${clearItems}});`);
        } else {
          lines.push(`${indent}ctx.resizeResource2D(${resIdx}, ${wExpr}, ${hExpr}, ${clearOnResize ? 'true' : 'false'});`);
        }
      } else {
        const sizeExpr = this.resolveArg(node, 'size', func, allFunctions, emitPure, edges);
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
        const dispatchExpr = this.resolveArg(node, 'dispatch', func, allFunctions, emitPure, edges);
        dimX = `static_cast<int>(${dispatchExpr}[0])`;
        dimY = `static_cast<int>(${dispatchExpr}[1])`;
        dimZ = '1';
      } else if (Array.isArray(dispatch)) {
        dimX = typeof dispatch[0] === 'number' ? String(dispatch[0]) : this.resolveArg({ ...node, dispatch: undefined, ['dispatch_x']: dispatch[0] } as Node, 'dispatch_x', func, allFunctions, emitPure, edges);
        dimY = typeof dispatch[1] === 'number' ? String(dispatch[1]) : this.resolveArg({ ...node, dispatch: undefined, ['dispatch_y']: dispatch[1] } as Node, 'dispatch_y', func, allFunctions, emitPure, edges);
        dimZ = typeof dispatch[2] === 'number' ? String(dispatch[2]) : this.resolveArg({ ...node, dispatch: undefined, ['dispatch_z']: dispatch[2] } as Node, 'dispatch_z', func, allFunctions, emitPure, edges);
      } else {
        dimX = '1'; dimY = '1'; dimZ = '1';
      }

      // Build args - serialize all inputs as flat floats for GPU marshalling
      const targetFuncDef = allFunctions.find(f => f.id === targetFunc);
      const hasExplicitInputs = targetFuncDef?.inputs && targetFuncDef.inputs.length > 0;

      // If shader has no explicit inputs but IR has global inputs, serialize those
      const hasGlobalInputs = !hasExplicitInputs && this.ir?.inputs && this.ir.inputs.length > 0;

      if (hasExplicitInputs) {
        lines.push(`${indent}{`);
        lines.push(`${indent}    std::vector<float> _shader_args;`);

        for (const input of targetFuncDef!.inputs!) {
          let argExpr: string;
          if (node['args'] && node['args'][input.id]) {
            const argId = node['args'][input.id];
            argExpr = this.resolveArg({ ...node, [input.id]: argId } as Node, input.id, func, allFunctions, emitPure, edges);
          } else if (node[input.id] !== undefined) {
            argExpr = this.resolveArg(node, input.id, func, allFunctions, emitPure, edges);
          } else {
            argExpr = '0.0f';
          }

          const irType = input.type || 'float';
          this.emitArgFlattening(`${indent}    `, argExpr, irType, lines);
        }

        lines.push(`${indent}    ctx.dispatchShader("${targetFunc}", ${dimX}, ${dimY}, ${dimZ}, _shader_args);`);
        lines.push(`${indent}}`);
      } else if (hasGlobalInputs) {
        // Serialize IR global inputs into args buffer for the shader
        lines.push(`${indent}{`);
        lines.push(`${indent}    std::vector<float> _shader_args;`);

        for (const input of this.ir!.inputs!) {
          const irType = input.type || 'float';
          const argExpr = `ctx.getInput("${input.id}")`;
          this.emitArgFlattening(`${indent}    `, argExpr, irType, lines);
        }

        lines.push(`${indent}    ctx.dispatchShader("${targetFunc}", ${dimX}, ${dimY}, ${dimZ}, _shader_args);`);
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}ctx.dispatchShader("${targetFunc}", ${dimX}, ${dimY}, ${dimZ});`);
      }
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
        // Check IR global inputs (input inheritance)
        if (this.ir?.inputs?.some(i => i.id === val)) return `ctx.getInput("${val}")`;
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
        // Fallback: check IR global inputs (input inheritance)
        if (this.ir?.inputs?.some(i => i.id === varId)) return `ctx.getInput("${varId}")`;
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
      case 'math_abs': return `abs(${val()})`;
      case 'math_sign': return `applyUnary(${val()}, [](float x) -> float { return x > 0.0f ? 1.0f : (x < 0.0f ? -1.0f : 0.0f); })`;
      case 'math_sin': return `sin(${val()})`;
      case 'math_cos': return `cos(${val()})`;
      case 'math_tan': return `tan(${val()})`;
      case 'math_asin': return `asin(${val()})`;
      case 'math_acos': return `acos(${val()})`;
      case 'math_atan': return `atan(${val()})`;
      case 'math_sinh': return `sinh(${val()})`;
      case 'math_cosh': return `cosh(${val()})`;
      case 'math_tanh': return `tanh(${val()})`;
      case 'math_sqrt': return `sqrt(${val()})`;
      case 'math_exp': return `exp(${val()})`;
      case 'math_exp2': return `exp2(${val()})`;
      case 'math_log': return `log(${val()})`;
      case 'math_log2': return `log2(${val()})`;
      case 'math_ceil': return `ceil(${val()})`;
      case 'math_floor': return `floor(${val()})`;
      case 'math_round': return `round(${val()})`;
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
      case 'math_step': { const edge = a('edge'); const v = a('val'); return `((${v}) >= (${edge}) ? 1.0f : 0.0f)`; }
      case 'math_smoothstep': {
        const e0 = a('edge0'); const e1 = a('edge1'); const v = a('val');
        return `([](float e0, float e1, float x) { float t = std::max(0.0f, std::min(1.0f, (x - e0) / (e1 - e0))); return t * t * (3.0f - 2.0f * t); }(${e0}, ${e1}, ${v}))`;
      }
      case 'math_mix':
      case 'math_lerp': return `([](auto a_, auto b_, auto t_) { return a_ + (b_ - a_) * t_; }(${a()}, ${b()}, ${a('t')}))`;
      case 'math_clamp': return `clamp_val(${a('val')}, ${a('min')}, ${a('max')})`;
      case 'math_mad': return `((${a()}) * (${b()}) + (${a('c')}))`;
      case 'math_select': return `((${a('cond')}) != 0.0f ? (${a('true')}) : (${a('false')}))`;

      // Comparisons
      case 'math_gt': return `applyBinary(${a()}, ${b()}, [](float x, float y) -> float { return x > y ? 1.0f : 0.0f; })`;
      case 'math_lt': return `applyBinary(${a()}, ${b()}, [](float x, float y) -> float { return x < y ? 1.0f : 0.0f; })`;
      case 'math_ge':
      case 'math_gte': return `applyBinary(${a()}, ${b()}, [](float x, float y) -> float { return x >= y ? 1.0f : 0.0f; })`;
      case 'math_le':
      case 'math_lte': return `applyBinary(${a()}, ${b()}, [](float x, float y) -> float { return x <= y ? 1.0f : 0.0f; })`;
      case 'math_eq': return `applyBinary(${a()}, ${b()}, [](float x, float y) -> float { return x == y ? 1.0f : 0.0f; })`;
      case 'math_neq': return `applyBinary(${a()}, ${b()}, [](float x, float y) -> float { return x != y ? 1.0f : 0.0f; })`;

      // Logic
      case 'math_and': return `((${a()}) != 0.0f && (${b()}) != 0.0f ? 1.0f : 0.0f)`;
      case 'math_or': return `((${a()}) != 0.0f || (${b()}) != 0.0f ? 1.0f : 0.0f)`;
      case 'math_xor': return `(((${a()}) != 0.0f) != ((${b()}) != 0.0f) ? 1.0f : 0.0f)`;
      case 'math_not': return `((${val()}) == 0.0f ? 1.0f : 0.0f)`;

      // Numeric analysis
      case 'math_is_nan': return `applyUnary(${val()}, [](float x) -> float { return std::isnan(x) ? 1.0f : 0.0f; })`;
      case 'math_is_inf': return `applyUnary(${val()}, [](float x) -> float { return std::isinf(x) ? 1.0f : 0.0f; })`;
      case 'math_is_finite': return `applyUnary(${val()}, [](float x) -> float { return std::isfinite(x) ? 1.0f : 0.0f; })`;
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

      case 'vec_dot': return `vec_dot(${a()}, ${b()})`;
      case 'vec_length': return `vec_length(${a()})`;
      case 'vec_normalize': return `vec_normalize(${a()})`;
      case 'vec_mix': return `vec_mix_impl(${a()}, ${b()}, ${a('t')})`;
      case 'vec_cross': {
        const va = a(); const vb = b();
        return `([](auto a_, auto b_) -> std::array<float, 3> { return {a_[1]*b_[2]-a_[2]*b_[1], a_[2]*b_[0]-a_[0]*b_[2], a_[0]*b_[1]-a_[1]*b_[0]}; }(${va}, ${vb}))`;
      }
      case 'vec_distance': {
        const va = a(); const vb = b();
        return `([](auto a_, auto b_) { float s = 0; for (size_t i = 0; i < a_.size(); ++i) { float d = a_[i] - b_[i]; s += d*d; } return std::sqrt(s); }(${va}, ${vb}))`;
      }
      case 'vec_reflect': {
        const va = a(); const vn = a('n');
        return `([](auto i_, auto n_) { float d = 2.0f * vec_dot(i_, n_); auto result = i_; for (size_t j = 0; j < i_.size(); ++j) result[j] = i_[j] - d * n_[j]; return result; }(${va}, ${vn}))`;
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
        const length = node['length'] || 0;
        const fill = node['fill'];
        let fillExpr: string;
        let elemType: string;

        if (fill === undefined) {
          fillExpr = '0.0f';
          elemType = 'float';
        } else if (typeof fill === 'number') {
          if (Number.isInteger(fill)) {
            fillExpr = String(fill);
            elemType = 'int';
          } else {
            fillExpr = this.formatFloat(fill);
            elemType = 'float';
          }
        } else if (typeof fill === 'string') {
          // Could be a node reference
          const refNode = func.nodes.find(n => n.id === fill);
          if (refNode) {
            emitPure(fill);
            fillExpr = this.nodeResId(fill);
            elemType = `decltype(${fillExpr})`;
          } else if (func.localVars.some(v => v.id === fill)) {
            fillExpr = this.sanitizeId(fill, 'var');
            elemType = `decltype(${fillExpr})`;
          } else {
            fillExpr = fill;
            elemType = 'float';
          }
        } else {
          fillExpr = String(fill);
          elemType = 'float';
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

      default:
        throw new Error(`C++ Generator: Unsupported op '${node.op}'`);
    }
  }

  /**
   * Emit code to flatten a C++ expression of a given IR type into _shader_args vector.
   * Handles scalars, vectors, matrices, structs, and arrays recursively.
   */
  private emitArgFlattening(indent: string, argExpr: string, irType: string, lines: string[]): void {
    switch (irType) {
      case 'float':
        lines.push(`${indent}_shader_args.push_back(${argExpr});`);
        break;
      case 'int':
      case 'i32':
        lines.push(`${indent}_shader_args.push_back(static_cast<float>(${argExpr}));`);
        break;
      case 'bool':
        lines.push(`${indent}_shader_args.push_back(${argExpr} ? 1.0f : 0.0f);`);
        break;
      case 'float2':
      case 'float3':
      case 'float4':
      case 'float3x3':
      case 'float4x4':
        lines.push(`${indent}_shader_args.insert(_shader_args.end(), ${argExpr}.begin(), ${argExpr}.end());`);
        break;
      default: {
        // Check for struct type
        const structDef = this.ir?.structs?.find(s => s.id === irType);
        if (structDef) {
          for (const member of structDef.members || []) {
            const memberExpr = `${argExpr}.${this.sanitizeId(member.name, 'field')}`;
            this.emitArgFlattening(indent, memberExpr, member.type, lines);
          }
          break;
        }
        // Check for fixed array: array<T, N>
        const arrayMatch = irType.match(/array<([^,]+),\s*(\d+)>/);
        if (arrayMatch) {
          const elemType = arrayMatch[1].trim();
          if (['float', 'int', 'i32', 'bool'].includes(elemType)) {
            lines.push(`${indent}for (auto& _e : ${argExpr}) _shader_args.push_back(static_cast<float>(_e));`);
          } else {
            const len = parseInt(arrayMatch[2]);
            for (let i = 0; i < len; i++) {
              this.emitArgFlattening(indent, `${argExpr}[${i}]`, elemType, lines);
            }
          }
          break;
        }
        // Check for dynamic array: T[]
        const dynMatch = irType.match(/^(.+)\[\]$/);
        if (dynMatch) {
          const elemType = dynMatch[1].trim();
          // Push length first, then flatten each element
          lines.push(`${indent}_shader_args.push_back(static_cast<float>(${argExpr}.size()));`);
          const elemStructDef = this.ir?.structs?.find(s => s.id === elemType);
          if (elemStructDef) {
            // Struct element: flatten each member per element
            lines.push(`${indent}for (size_t _i = 0; _i < ${argExpr}.size(); _i++) {`);
            for (const member of elemStructDef.members || []) {
              const memberExpr = `${argExpr}[_i].${this.sanitizeId(member.name, 'field')}`;
              this.emitArgFlattening(`${indent}    `, memberExpr, member.type, lines);
            }
            lines.push(`${indent}}`);
          } else {
            lines.push(`${indent}for (size_t _i = 0; _i < ${argExpr}.size(); _i++) {`);
            this.emitArgFlattening(`${indent}    `, `${argExpr}[_i]`, elemType, lines);
            lines.push(`${indent}}`);
          }
          break;
        }
        // Fallback: try as float
        lines.push(`${indent}_shader_args.push_back(static_cast<float>(${argExpr}));`);
      }
    }
  }
}
