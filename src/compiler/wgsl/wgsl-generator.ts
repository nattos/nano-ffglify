
import { FunctionDef, Node, Edge, DataType, ResourceDef, IRDocument } from '../../ir/types';

/**
 * WGSL Generator
 * Transpiles IR Functions into WGSL shader code.
 */

export interface WgslOptions {
  globalBufferBinding?: number; // If set, generate globals buffer and use it for var_get/set
  varMap?: Map<string, number>; // Map var name to index in globals buffer
  resourceBindings?: Map<string, number>; // Map resource ID (buffer/texture) to binding index (group 0)
  resourceDefs?: Map<string, ResourceDef>; // Definitions for typed buffer generation
}

export class WgslGenerator {

  compile(ir: IRDocument, entryPointId: string, options: WgslOptions = {}): string {
    const lines: string[] = [];
    const entryFunc = ir.functions.find(f => f.id === entryPointId);
    if (!entryFunc) throw new Error(`Entry point function '${entryPointId}' not found`);

    // Header
    lines.push('diagnostic(off, derivative_uniformity);');
    lines.push('');

    // Globals Buffer (for ComputeTestBackend)
    lines.push('struct GlobalsBuffer { data: array<f32> }');
    lines.push('');

    if (options.globalBufferBinding !== undefined) {
      lines.push(`@group(0) @binding(${options.globalBufferBinding}) var<storage, read_write> b_globals : GlobalsBuffer;`);
    }

    // Resource Bindings
    if (options.resourceBindings) {
      options.resourceBindings.forEach((bindingIdx, resId) => {
        const def = options.resourceDefs?.get(resId);
        const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
        const structName = `Buffer_${resId}`;
        lines.push(`struct ${structName} { data: array<${type}> }`);
        lines.push(`@group(0) @binding(${bindingIdx}) var<storage, read_write> b_${resId} : ${structName};`);
      });
    }

    lines.push('fn color_mix_impl(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {');
    lines.push('  let srcA = src.w;');
    lines.push('  let dstA = dst.w;');
    lines.push('  let outA = srcA + dstA * (1.0 - srcA);');
    lines.push('  if (outA < 1e-5) { return vec4<f32>(0.0); }');
    lines.push('  let outRGB = (src.xyz * srcA + dst.xyz * dstA * (1.0 - srcA)) / outA;');
    lines.push('  return vec4<f32>(outRGB, outA);');
    lines.push('}');
    lines.push('');

    // Generate Structs
    this.generateStructs(ir, lines);

    // Generate Helper Functions (All except Entry Point)
    // Filter out entry point
    const helperFuncs = ir.functions.filter(f => f.id !== entryPointId);

    // Sort? For now, assume order is mostly fine or use forward declarations (not supported in WGSL 1.0 same-scope but strict ordering is safer).
    // Actually WGSL allows calling functions defined later.
    for (const func of helperFuncs) {
      this.emitFunction(func, false, lines, options, ir);
      lines.push('');
    }

    // Generate Entry Point
    this.emitFunction(entryFunc, true, lines, options, ir);

    return lines.join('\n');
  }

  private generateStructs(ir: IRDocument, lines: string[]) {
    if (!ir.structs) return;
    for (const s of ir.structs) {
      lines.push(`struct ${s.id} {`);
      for (const m of s.members) {
        const type = this.resolveType(m.type);
        lines.push(`  ${m.name} : ${type},`);
      }
      lines.push(`}`);
      lines.push('');
    }
  }

  private emitFunction(func: FunctionDef, isEntryPoint: boolean, lines: string[], options: WgslOptions, ir: IRDocument) {
    if (isEntryPoint) {
      lines.push(`@compute @workgroup_size(1, 1, 1)`);
      lines.push(`fn main(@builtin(global_invocation_id) GlobalInvocationID : vec3<u32>) {`);
    } else {
      // Signature
      const args = func.inputs.map(arg => {
        const type = this.resolveType(arg.type);
        return `${arg.id}: ${type}`;
      }).join(', ');

      let retType = 'void';
      if (func.outputs.length === 1) {
        retType = this.resolveType(func.outputs[0].type);
      } else if (func.outputs.length > 1) {
        console.warn(`[WgslGenerator] Multi-value return not implemented for ${func.id}`);
        retType = 'void';
      }

      lines.push(`fn ${func.id}(${args}) -> ${retType} {`);
    }

    // Locals
    func.localVars.forEach(v => {
      // Arrays need special handling for initialization?
      const type = this.resolveType(v.type);
      let init = v.initialValue !== undefined ? this.formatLiteral(v.initialValue, v.type) : this.formatZero(v.type);

      // If array and default init, formatZero might handle it if type is explicit.
      // But formatZero relies on type string parsing.

      lines.push(`  var l_${v.id} : ${type} = ${init};`);
    });

    this.emitBody(func, lines, options, new Set(), ir);

    lines.push(`}`);
  }

  private emitBody(func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>, ir: IRDocument) {
    // 1. Find Entry Nodes
    const entryNodes = func.nodes.filter(n => {
      // Logic nodes with no incoming execution edge
      const hasExecIn = func.edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op);
    });

    for (const entry of entryNodes) {
      this.emitChain(entry, func, lines, options, visited, ir);
    }
  }

  private isExecutable(op: string) {
    return op.startsWith('cmd_') || op.startsWith('flow_') ||
      op === 'var_set' || op === 'buffer_store' || op === 'texture_store' ||
      op === 'call_func' || op === 'func_return' || op === 'array_set';
  }

  private emitChain(startNode: Node, func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>, ir: IRDocument) {
    let curr: Node | undefined = startNode;
    while (curr) {
      if (visited.has(curr.id)) break;
      visited.add(curr.id);

      this.emitNode(curr, func, lines, options, ir);

      // Next
      // Check for flow_branch special handling?
      // flow_branch has 'exec_true', 'exec_false'.
      // emitNode handles expanding branches.
      // So we stop linear chain if it's a branch?
      if (curr.op === 'flow_branch') {
        // Branch handled recursively in emitNode, stop linear chain here?
        // Wait, flow_branch in 'emitNode' usually recursively calls emitChain for true/false blocks.
        // So we should break the loop.
        break;
      }

      // Standard linear next
      const edge = func.edges.find(e => e.from === curr!.id && e.portOut === 'exec_out' && e.type === 'execution');
      curr = edge ? func.nodes.find(n => n.id === edge.to) : undefined;
    }
  }

  private emitNode(node: Node, func: FunctionDef, lines: string[], options: WgslOptions, ir: IRDocument) {
    const indent = '  ';

    if (node.op === 'var_set') {
      const val = this.resolveArg(node, 'val', func, options, ir);
      const varId = node['var'];
      if (options.varMap?.has(varId)) {
        const idx = options.varMap.get(varId)!;
        lines.push(`${indent}b_globals.data[${idx}] = ${val};`);
      } else if (func.localVars.some(v => v.id === varId)) {
        lines.push(`${indent}l_${varId} = ${val};`);
      }
    } else if (node.op === 'array_set') {
      const arr = this.resolveArg(node, 'array', func, options, ir); // Should return l_arr
      const idx = this.resolveArg(node, 'index', func, options, ir);
      const val = this.resolveArg(node, 'value', func, options, ir);
      // This relies on 'arr' resolving to an L-Value (variable name)
      // Ops like var_get return l_xx.
      lines.push(`${indent}${arr}[u32(${idx})] = ${val};`);
    } else if (node.op === 'buffer_store') {
      const idx = this.resolveArg(node, 'index', func, options, ir);
      const val = this.resolveArg(node, 'value', func, options, ir);
      const bufferId = node['buffer'];
      // Resolve buffer type to cast value
      const def = options.resourceDefs?.get(bufferId);
      const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
      // If type is vec/mat, val should match. If scalar, cast.
      // E.g. f32(val).
      // If inferred type is same, cast is harmless (f32(1.0) -> 1.0).
      lines.push(`${indent}b_${bufferId}.data[u32(${idx})] = ${type}(${val});`);
    } else if (node.op === 'call_func') {
      const funcId = node['func'];
      const targetFunc = ir.functions.find(f => f.id === funcId);
      if (targetFunc) {
        // Resolve Args
        // Inputs: targetFunc.inputs
        // Arguments in node: input.id (Direct property match)
        const args = targetFunc.inputs.map(inp => {
          const argKey = inp.id;
          return this.resolveArg(node, argKey, func, options, ir);
        }).join(', ');

        const callExpr = `${funcId}(${args})`;

        // Handle Return Value:
        // Since 'call_func' is an execution node, we emit the call statement here.
        // If it returns a value, we capture it in a temporary variable (v_nodeID)
        // so that downstream data nodes can reference it later via resolveArg.

        if (targetFunc.outputs.length > 0) {
          lines.push(`${indent}let v_${node.id} = ${callExpr};`);
        } else {
          lines.push(`${indent}${callExpr};`);
        }
      } else {
        lines.push(`${indent}// Unknown function: ${funcId}`);
      }
    } else if (node.op === 'func_return') {
      const val = this.resolveArg(node, 'val', func, options, ir);
      lines.push(`${indent}return ${val};`);
    } else if (node.op === 'flow_branch') {
      const cond = this.resolveArg(node, 'cond', func, options, ir);
      lines.push(`${indent}if (${cond} != 0.0) {`);
      // True Path
      const trueEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_true');
      if (trueEdge) {
        const trueNode = func.nodes.find(n => n.id === trueEdge.to);
        if (trueNode) this.emitChain(trueNode, func, lines, options, new Set(), ir);
      }
      lines.push(`${indent}} else {`);
      // False Path
      const falseEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_false');
      if (falseEdge) {
        const falseNode = func.nodes.find(n => n.id === falseEdge.to);
        if (falseNode) this.emitChain(falseNode, func, lines, options, new Set(), ir);
      }
      lines.push(`${indent}}`);
    } else {
      lines.push(`${indent}// Op: ${node.op}`);
    }
  }

  private resolveArg(node: Node, key: string, func: FunctionDef, options: WgslOptions, ir: IRDocument): string {
    const edge = func.edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
    if (edge) {
      const src = func.nodes.find(n => n.id === edge.from);
      if (src) {
        // If src is 'call_func', it was executed previously and stored in v_ID
        if (src.op === 'call_func') {
          return `v_${src.id}`;
        }
        // If src is 'var_get', it wraps a local or global
        if (src.op === 'var_get') {
          const varId = src['var'];
          if (func.localVars.some(v => v.id === varId)) return `l_${varId}`; // Local var
          if (options.varMap?.has(varId)) { // Global var
            const idx = options.varMap.get(varId)!;
            return `b_globals.data[${idx}]`;
          }
          // Function Argument?
          if (func.inputs.some(i => i.id === varId)) return varId;
          throw new Error(`Variable '${varId}' is not defined`);
        }
        // If src is 'struct_construct' or 'array_construct' or 'array_extract' etc., compileExpression handles it.
        return this.compileExpression(src, func, options, ir);
      }
    }
    if (node[key] !== undefined) {
      return this.formatLiteral(node[key], 'unknown');
    }
    return '0.0'; // Default?
  }

  private compileExpression(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument): string {
    if (node.op === 'literal') return this.formatLiteral(node['val'], 'float');

    // Constructors
    if (node.op === 'float2') return `vec2<f32>(${this.resolveArg(node, 'x', func, options, ir)}, ${this.resolveArg(node, 'y', func, options, ir)})`;
    if (node.op === 'float3') return `vec3<f32>(${this.resolveArg(node, 'x', func, options, ir)}, ${this.resolveArg(node, 'y', func, options, ir)}, ${this.resolveArg(node, 'z', func, options, ir)})`;
    if (node.op === 'float4') return `vec4<f32>(${this.resolveArg(node, 'x', func, options, ir)}, ${this.resolveArg(node, 'y', func, options, ir)}, ${this.resolveArg(node, 'z', func, options, ir)}, ${this.resolveArg(node, 'w', func, options, ir)})`;

    // Struct Construct
    if (node.op === 'struct_construct') {
      const type = node['type'];
      const structDef = ir.structs?.find(s => s.id === type);
      let args: string[] = [];

      if (structDef) {
        args = structDef.members.map(m => {
          // Find input arg matching member name
          return this.resolveArg(node, m.name, func, options, ir);
        });
      } else {
        console.warn(`[WgslGenerator] Struct def '${type}' not found`);
        // Try to use all properties? No, unsafe.
      }
      return `${type}(${args.join(', ')})`;
    }

    // Array Construct
    if (node.op === 'array_construct') {
      // array<Type, N>(val1, val2...)
      // The node has 'length', 'fill'.
      const len = node['length'];
      const fill = node['fill'];
      if (fill !== undefined) {
        // Try to infer type
        const isInt = typeof fill === 'number' && Number.isInteger(fill);
        const elemType = isInt ? 'i32' : 'f32';
        // Explicitly pass inherited type to formatLiteral so formatLiteral(0, 'i32') -> '0'.
        const vals = new Array(len).fill(null).map(() => this.formatLiteral(fill, elemType));
        return `array<${elemType}, ${len}>(${vals.join(', ')})`;
      }
    }

    // Array Extract
    if (node.op === 'array_extract') {
      const arr = this.resolveArg(node, 'array', func, options, ir);
      const idx = this.resolveArg(node, 'index', func, options, ir);
      return `${arr}[u32(${idx})]`;
    }

    if (node.op === 'color_mix') {
      const a = this.resolveArg(node, 'a', func, options, ir);
      const b = this.resolveArg(node, 'b', func, options, ir);
      return `color_mix_impl(${a}, ${b})`;
    }
    // Swizzles and Element Access
    if (node.op === 'vec_swizzle') {
      const vec = this.resolveArg(node, 'vec', func, options, ir);
      const channels = node['channels'];
      return `${vec}.${channels}`;
    }
    if (node.op === 'vec_get_element') {
      const vec = this.resolveArg(node, 'vec', func, options, ir);
      // We need 'index'. resolveArg of 'index' returns string (e.g. "1.0" or "i").
      // Vector access requires integer or literal int.
      // resolveArg returns formatted float usually? "1.0".
      // `vec[u32(idx)]` ?
      const idx = this.resolveArg(node, 'index', func, options, ir);
      return `${vec}[u32(${idx})]`;
    }
    if (node.op === 'struct_extract') {
      const struct = this.resolveArg(node, 'struct', func, options, ir);
      const field = node['field'];
      return `${struct}.${field}`;
    }

    if (node.op.startsWith('math_') || node.op.startsWith('vec_')) {
      return this.compileMathOp(node, func, options, ir);
    }

    return '0.0'; // Fallback
  }

  private formatLiteral(val: any, type: string | DataType): string {
    if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        // If type explicitly requests float/f32, format as float.
        if (type === 'float' || type === 'f32') return `${val}.0`;
        // If type implies int (or unknown default), format as int.
        return `${val}`;
      }
      return `${val}`;
    }
    if (Array.isArray(val)) {
      // Parse type hint if it's "array<T, N>"
      let elemType = 'float';
      if (typeof type === 'string' && type.startsWith('array<')) {
        // Extract T
        const match = type.match(/array<(.+),/);
        if (match) elemType = match[1];
      }

      // Construct vector/array
      const comp = val.map(v => this.formatLiteral(v, elemType)).join(', ');

      if (val.length === 2 && (type === 'float2' || type === 'vec2<f32>')) return `vec2<f32>(${comp})`;
      if (val.length === 3 && (type === 'float3' || type === 'vec3<f32>')) return `vec3<f32>(${comp})`;
      if (val.length === 4 && (type === 'float4' || type === 'vec4<f32>')) return `vec4<f32>(${comp})`;

      // If array definition is known (e.g. array<i32, 3>) but val is empty, we must zero init?
      // But val is the literal value. If it is empty array [], it means length 0?
      // If variable has type array<i32, 3>, and init is [], we cannot satisfy it with array constructor of 0 elems.
      // We should use formatZero(type) instead if val is empty/default?
      // But formatLiteral is called with val.
      // If val is [] and expected type is array<i32, 3>, we should fill with zeros?
      if (typeof type === 'string' && type.startsWith('array<') && val.length === 0) {
        return this.formatZero(type);
      }

      // Default array constructor
      return `array<${elemType},${val.length}>(${comp})`;
    }
    if (typeof val === 'boolean') {
      return val ? 'true' : 'false';
    }
    return `${val}`;
  }

  private formatZero(type: string | DataType): string {
    if (type === 'float' || type === 'f32') return '0.0';
    if (type === 'int' || type === 'i32') return '0';
    if (type === 'bool') return 'false';
    if (type === 'float2' || type === 'vec2<f32>') return 'vec2<f32>(0.0)';
    if (type === 'float3' || type === 'vec3<f32>') return 'vec3<f32>(0.0)';
    if (type === 'float4' || type === 'vec4<f32>') return 'vec4<f32>(0.0)';

    // Array zero init
    if (typeof type === 'string' && type.startsWith('array<')) {
      return `${type}()`; // Zero-init constructor syntax? "array<i32, 3>()" is valid in WGSL (default construct).
    }

    return '0.0';
  }

  private compileMathOp(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument): string {
    const op = node.op;
    const a = (k = 'a') => this.resolveArg(node, k, func, options, ir);
    const b = (k = 'b') => this.resolveArg(node, k, func, options, ir);
    const val = (k = 'val') => this.resolveArg(node, k, func, options, ir);

    // Basic Arithmetic
    if (op === 'math_add') return `(${a()} + ${b()})`;
    if (op === 'math_sub') return `(${a()} - ${b()})`;
    if (op === 'math_mul') return `(${a()} * ${b()})`;
    if (op === 'math_div') return `(${a()} / ${b()})`;
    if (op === 'math_mod') return `(${a()} - ${b()} * floor(${a()} / ${b()}))`;
    if (op === 'math_mad') return `fma(${a()}, ${b()}, ${this.resolveArg(node, 'c', func, options, ir)})`;

    // Unary Main
    if (op === 'math_abs') return `abs(${val()})`;
    if (op === 'math_floor') return `floor(${val()})`;
    if (op === 'math_ceil') return `ceil(${val()})`;
    if (op === 'math_fract') return `fract(${val()})`;
    if (op === 'math_sqrt') return `sqrt(${val()})`;
    if (op === 'math_exp') return `exp(${val()})`;
    if (op === 'math_log') return `log(${val()})`;
    if (op === 'math_sin') return `sin(${val()})`;
    if (op === 'math_cos') return `cos(${val()})`;
    if (op === 'math_tan') return `tan(${val()})`;
    if (op === 'math_tanh') return `tanh(${val()})`;
    if (op === 'math_atan') return `atan(${val()})`;
    if (op === 'math_sign') return `sign(${val()})`;

    // Binary / Ternary
    if (op === 'math_pow') return `pow(${a()}, ${b()})`;
    if (op === 'math_min') return `min(${a()}, ${b()})`;
    if (op === 'math_max') return `max(${a()}, ${b()})`;
    if (op === 'math_clamp') return `clamp(${val()}, ${this.resolveArg(node, 'min', func, options, ir)}, ${this.resolveArg(node, 'max', func, options, ir)})`;
    if (op === 'math_atan2') return `atan2(${this.resolveArg(node, 'a', func, options, ir)}, ${this.resolveArg(node, 'b', func, options, ir)})`;
    if (op === 'math_mix') return `mix(${a()}, ${b()}, ${this.resolveArg(node, 't', func, options, ir)})`;

    if (op === 'vec_dot') return `dot(${a()}, ${b()})`;
    if (op === 'vec_length') return `length(${this.resolveArg(node, 'a', func, options, ir) === '0.0' ? val('val') : this.resolveArg(node, 'a', func, options, ir)})`;
    if (op === 'vec_normalize') return `normalize(${this.resolveArg(node, 'a', func, options, ir)})`;
    if (op === 'vec_mix') return `mix(${a()}, ${b()}, ${this.resolveArg(node, 't', func, options, ir)})`;

    // Logic & Cmparison (Returns bool? Cast to float?)
    if (op === 'math_lt') return `select(0.0, 1.0, ${a()} < ${b()})`;
    if (op === 'math_gt') return `select(0.0, 1.0, ${a()} > ${b()})`;
    if (op === 'math_le') return `select(0.0, 1.0, ${a()} <= ${b()})`;
    if (op === 'math_ge') return `select(0.0, 1.0, ${a()} >= ${b()})`;
    if (op === 'math_eq') return `select(0.0, 1.0, ${a()} == ${b()})`;
    if (op === 'math_neq') return `select(0.0, 1.0, ${a()} != ${b()})`;

    // Boolean Logic (assuming scalar 0.0/1.0 inputs or bools)
    // If inputs are floats (from select), we need `!= 0.0`.
    // WGSL logic `&`, `|` are for bools.
    const toBool = (expr: string) => `(${expr} != 0.0)`;
    if (op === 'math_and') return `select(0.0, 1.0, ${toBool(a())} && ${toBool(b())})`;
    if (op === 'math_or') return `select(0.0, 1.0, ${toBool(a())} || ${toBool(b())})`;
    if (op === 'math_xor') return `select(0.0, 1.0, ${toBool(a())} != ${toBool(b())})`; // XOR for bools is !=
    if (op === 'math_not') return `select(0.0, 1.0, !${toBool(val())})`;

    // Constants
    if (op === 'math_pi') return '3.14159265359';
    if (op === 'math_e') return '2.71828182846';

    return `/* ${op} */ 0.0`;
  }

  private resolveType(type: DataType | string): string {
    // console.log(`[WgslGenerator] Resolving type: '${type}'`);
    // Map IR types to WGSL types
    if (type === 'float' || type === 'f32') return 'f32';
    if (type === 'int' || type === 'i32') return 'i32';
    if (type === 'bool') return 'bool';
    if (type === 'float2' || type === 'vec2<f32>') return 'vec2<f32>';
    if (type === 'float3' || type === 'vec3<f32>') return 'vec3<f32>';
    if (type === 'float4' || type === 'vec4<f32>') return 'vec4<f32>';
    if (type === 'float3x3' || type === 'mat3x3<f32>') return 'mat3x3<f32>';
    if (type === 'float4x4' || type === 'mat4x4<f32>') return 'mat4x4<f32>';

    // Fallback: Assume it's a struct name or user type
    // In strict mode we should check in IR.
    return type; // Default
  }
}
