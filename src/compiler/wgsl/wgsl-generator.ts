
import { FunctionDef, Node, Edge, DataType, ResourceDef } from '../../ir/types';

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

  compile(func: FunctionDef, options: WgslOptions = {}): string {
    const lines: string[] = [];

    // Header
    lines.push('diagnostic(off, derivative_uniformity);');
    lines.push('');

    // Globals Buffer (for ComputeTestBackend)
    // We use a struct wrapper for compatibility
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

        // Define Struct
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

    // Function Body
    lines.push(`@compute @workgroup_size(1, 1, 1)`);
    lines.push(`fn main(@builtin(global_invocation_id) GlobalInvocationID : vec3<u32>) {`);

    // Locals
    // We declare locals based on 'localVars'.
    // Since this is a test kernel, we can treat all locals as mutable vars for now.
    func.localVars.forEach(v => {
      const type = this.resolveType(v.type);
      // Initial value?
      const init = v.initialValue !== undefined ? this.formatLiteral(v.initialValue, v.type) : this.formatZero(v.type);
      lines.push(`  var l_${v.id} : ${type} = ${init};`);
    });

    // Traverse Graph
    this.emitBody(func, lines, options, new Set());

    lines.push(`}`);

    return lines.join('\n');
  }

  private emitBody(func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>) {
    // 1. Find Entry Nodes
    const entryNodes = func.nodes.filter(n => {
      const hasExecIn = func.edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op);
    });

    for (const entry of entryNodes) {
      this.emitChain(entry, func, lines, options, visited);
    }
  }

  private isExecutable(op: string) {
    return op.startsWith('cmd_') || op.startsWith('flow_') ||
      op === 'var_set' || op === 'buffer_store' || op === 'texture_store' || op === 'call_func';
  }

  private emitChain(startNode: Node, func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>) {
    let curr: Node | undefined = startNode;
    while (curr) {
      if (visited.has(curr.id)) {
        // Loop or Merge. Stop for now (except loops handle themselves)
        break;
      }
      visited.add(curr.id);

      this.emitNode(curr, func, lines, options);

      // Next
      const edge = func.edges.find(e => e.from === curr!.id && e.portOut === 'exec_out' && e.type === 'execution');
      curr = edge ? func.nodes.find(n => n.id === edge.to) : undefined;
    }
  }

  private emitNode(node: Node, func: FunctionDef, lines: string[], options: WgslOptions) {
    const indent = '  ';

    if (node.op === 'var_set') {
      const val = this.resolveArg(node, 'val', func, options);
      const varId = node['var'];

      // Check if it's Global (in varMap)
      if (options.varMap?.has(varId)) {
        const idx = options.varMap.get(varId)!;
        // Write to buffer
        lines.push(`${indent}b_globals.data[${idx}] = ${val};`);
      }
      // Local?
      else if (func.localVars.some(v => v.id === varId)) {
        lines.push(`${indent}l_${varId} = ${val};`);
      }
    } else if (node.op === 'buffer_store') {
      const idx = this.resolveArg(node, 'index', func, options);
      const val = this.resolveArg(node, 'value', func, options);
      const bufferId = node['buffer'];

      // Standard Store (No implicit flattening)
      lines.push(`${indent}b_${bufferId}.data[u32(${idx})] = ${val};`);
    } else {
      lines.push(`${indent}// Op: ${node.op}`);
    }
  }

  private resolveArg(node: Node, key: string, func: FunctionDef, options: WgslOptions): string {
    // 1. Edge
    const edge = func.edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
    if (edge) {
      const src = func.nodes.find(n => n.id === edge.from);
      if (src) return this.compileExpression(src, func, options);
    }

    // 2. Literal
    if (node[key] !== undefined) {
      return this.formatLiteral(node[key], 'float'); // Infer type?
    }
    return '0.0';
  }

  private compileExpression(node: Node, func: FunctionDef, options: WgslOptions): string {
    if (node.op === 'literal') return this.formatLiteral(node['val'], 'float');

    // Constructors
    if (node.op === 'float2') return `vec2<f32>(${this.resolveArg(node, 'x', func, options)}, ${this.resolveArg(node, 'y', func, options)})`;
    if (node.op === 'float3') return `vec3<f32>(${this.resolveArg(node, 'x', func, options)}, ${this.resolveArg(node, 'y', func, options)}, ${this.resolveArg(node, 'z', func, options)})`;
    if (node.op === 'float4') return `vec4<f32>(${this.resolveArg(node, 'x', func, options)}, ${this.resolveArg(node, 'y', func, options)}, ${this.resolveArg(node, 'z', func, options)}, ${this.resolveArg(node, 'w', func, options)})`;
    if (node.op === 'color_mix') {
      const a = this.resolveArg(node, 'a', func, options);
      const b = this.resolveArg(node, 'b', func, options);
      return `color_mix_impl(${a}, ${b})`;
    }
    // Swizzles and Element Access
    if (node.op === 'vec_swizzle') {
      const vec = this.resolveArg(node, 'vec', func, options);
      const channels = node['channels']; // 'xy', 'z' etc.
      return `${vec}.${channels}`;
    }
    if (node.op === 'vec_get_element') {
      const vec = this.resolveArg(node, 'vec', func, options);
      // We need 'index'. resolveArg of 'index' returns string (e.g. "1.0" or "i").
      // Vector access requires integer or literal int.
      // resolveArg returns formatted float usually? "1.0".
      // `vec[u32(idx)]` ?
      const idx = this.resolveArg(node, 'index', func, options);
      return `${vec}[u32(${idx})]`;
    }

    if (node.op.startsWith('math_') || node.op.startsWith('vec_')) {
      return this.compileMathOp(node, func, options);
    }

    return '0.0'; // Fallback
  }

  private formatLiteral(val: any, type: string | DataType): string {
    if (typeof val === 'number') {
      if (Number.isInteger(val) && type !== 'float' && type !== 'f32') return `${val}`;
      return Number.isInteger(val) ? `${val}.0` : `${val}`;
    }
    if (Array.isArray(val)) {
      // Construct vector
      const comp = val.map(v => this.formatLiteral(v, 'float')).join(', ');
      if (val.length === 2) return `vec2<f32>(${comp})`;
      if (val.length === 3) return `vec3<f32>(${comp})`;
      if (val.length === 4) return `vec4<f32>(${comp})`;
      // Arrays?
      return `array<f32,${val.length}>(${comp})`;
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
    return '0.0';
  }

  private compileMathOp(node: Node, func: FunctionDef, options: WgslOptions): string {
    const op = node.op;
    const a = (k = 'a') => this.resolveArg(node, k, func, options);
    const b = (k = 'b') => this.resolveArg(node, k, func, options);
    const val = (k = 'val') => this.resolveArg(node, k, func, options);

    // Basic Arithmetic
    if (op === 'math_add') return `(${a()} + ${b()})`;
    if (op === 'math_sub') return `(${a()} - ${b()})`;
    if (op === 'math_mul') return `(${a()} * ${b()})`;
    if (op === 'math_div') return `(${a()} / ${b()})`;
    if (op === 'math_mod') return `(${a()} - ${b()} * floor(${a()} / ${b()}))`;
    if (op === 'math_mad') return `fma(${a()}, ${b()}, ${this.resolveArg(node, 'c', func, options)})`;

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
    if (op === 'math_clamp') return `clamp(${val()}, ${this.resolveArg(node, 'min', func, options)}, ${this.resolveArg(node, 'max', func, options)})`;
    if (op === 'math_atan2') return `atan2(${this.resolveArg(node, 'a', func, options)}, ${this.resolveArg(node, 'b', func, options)})`;
    if (op === 'math_mix') return `mix(${a()}, ${b()}, ${this.resolveArg(node, 't', func, options)})`;

    if (op === 'vec_dot') return `dot(${a()}, ${b()})`;
    if (op === 'vec_length') return `length(${this.resolveArg(node, 'a', func, options) === '0.0' ? val('val') : this.resolveArg(node, 'a', func, options)})`;
    if (op === 'vec_normalize') return `normalize(${this.resolveArg(node, 'a', func, options)})`;
    if (op === 'vec_mix') return `mix(${a()}, ${b()}, ${this.resolveArg(node, 't', func, options)})`;

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

  private resolveType(type: DataType): string {
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
    return 'f32'; // Default
  }
}
