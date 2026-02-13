import { BuiltinOp } from './types';
import { BUILTIN_TYPES } from './builtin-schemas';

export type ValidationType =
  | 'float'  // Generic scalar (float)
  | 'int'     // Integer (for loops, strict checks)
  | 'boolean'
  | 'string'
  | 'float2'
  | 'float3'
  | 'float4'
  | 'int2'
  | 'int3'
  | 'int4'
  | 'float3x3'
  | 'float4x4'
  | 'struct' // Generic Struct
  | 'array'  // Generic Array
  | 'any'    // Fallback
  | (string & {}); // Dynamic types (struct IDs, array patterns)

export interface OpSignature {
  inputs: Record<string, ValidationType>;
  output: ValidationType;
}

const genMathVariants = (op: BuiltinOp, returnType: 'same' | 'boolean_vec'): OpSignature[] => {
  const types: ValidationType[] = ['float', 'float2', 'float3', 'float4', 'int', 'int2', 'int3', 'int4'];
  const variants: OpSignature[] = [];

  // Standard (T, T) -> T (or bvec/bool)
  types.forEach(t => {
    let out = t;
    if (returnType === 'boolean_vec') {
      out = (t === 'float') ? 'boolean' : t;
    }
    variants.push({ inputs: { a: t, b: t }, output: out });
  });

  // Broadcasting (vecN, float) -> vecN and (float, vecN) -> vecN
  // Only for non-boolean returns
  if (returnType === 'same') {
    ['float2', 'float3', 'float4'].forEach(t => {
      const vt = t as ValidationType;
      variants.push({ inputs: { a: vt, b: 'float' }, output: vt });
      variants.push({ inputs: { a: 'float', b: vt }, output: vt });
    });
    // Add (int, int) -> int explicitly if not already covered by genType loop
    // It's covered above by adding 'int' to types array.
  }

  return variants;
};

const genUnaryVariants = (op: BuiltinOp, returnType: 'same' | 'boolean_vec'): OpSignature[] => {
  const types: ValidationType[] = ['float', 'float2', 'float3', 'float4', 'int', 'int2', 'int3', 'int4'];
  return types.map(t => {
    let out = t;
    if (returnType === 'boolean_vec') {
      out = (t === 'float') ? 'boolean' : t;
    }
    return { inputs: { val: t }, output: out };
  });
};

const MATH_OPS: BuiltinOp[] = [
  'math_add', 'math_sub', 'math_mul', 'math_div', 'math_mod', 'math_pow',
  'math_min', 'math_max'
];

const LOGIC_OPS: BuiltinOp[] = [
  'math_gt', 'math_lt', 'math_ge', 'math_le', 'math_eq', 'math_neq'
];

const UNARY_OPS: BuiltinOp[] = [
  'math_sin', 'math_cos', 'math_tan', 'math_asin', 'math_acos', 'math_atan',
  'math_sinh', 'math_cosh', 'math_tanh', 'math_sign', 'math_exp', 'math_log', 'math_sqrt',
  'math_abs', 'math_ceil', 'math_floor', 'math_round',
  'math_fract', 'math_trunc',
  'math_flush_subnormal', 'math_mantissa', 'math_exponent',
  'math_frexp_mantissa', 'math_frexp_exponent'
];

// Helper to merge
const signatures: Partial<Record<BuiltinOp, OpSignature[]>> = {
  'math_div_scalar': [
    { inputs: { val: 'float', scalar: 'float' }, output: 'float' },
    { inputs: { val: 'float2', scalar: 'float' }, output: 'float2' },
    { inputs: { val: 'float3', scalar: 'float' }, output: 'float3' },
    { inputs: { val: 'float4', scalar: 'float' }, output: 'float4' },
  ],
  'math_ldexp': [
    { inputs: { fract: 'float', exp: 'int' }, output: 'float' },
    { inputs: { fract: 'float2', exp: 'int' }, output: 'float2' },
    { inputs: { fract: 'float3', exp: 'int' }, output: 'float3' },
    { inputs: { fract: 'float4', exp: 'int' }, output: 'float4' },
    { inputs: { fract: 'float2', exp: 'float2' }, output: 'float2' },
    { inputs: { fract: 'float3', exp: 'float3' }, output: 'float3' },
    { inputs: { fract: 'float4', exp: 'float4' }, output: 'float4' },
  ],
};

MATH_OPS.forEach(op => signatures[op] = genMathVariants(op, 'same'));
LOGIC_OPS.forEach(op => signatures[op] = genMathVariants(op, 'boolean_vec'));
UNARY_OPS.forEach(op => signatures[op] = genUnaryVariants(op, 'same'));

export const OpSignatures: Partial<Record<BuiltinOp, OpSignature[]>> = {
  ...signatures,

  'math_mad': [
    { inputs: { a: 'float', b: 'float', c: 'float' }, output: 'float' },
    { inputs: { a: 'float2', b: 'float2', c: 'float2' }, output: 'float2' },
    { inputs: { a: 'float3', b: 'float3', c: 'float3' }, output: 'float3' },
    { inputs: { a: 'float3', b: 'float3', c: 'float3' }, output: 'float3' },
    { inputs: { a: 'float4', b: 'float4', c: 'float4' }, output: 'float4' },
    // Broadcasting for MAD (vec * scalar + scalar is common)
    { inputs: { a: 'float2', b: 'float', c: 'float' }, output: 'float2' },
    { inputs: { a: 'float3', b: 'float', c: 'float' }, output: 'float3' },
    { inputs: { a: 'float4', b: 'float', c: 'float' }, output: 'float4' },
  ],

  'math_clamp': [
    { inputs: { val: 'float', min: 'float', max: 'float' }, output: 'float' },
    { inputs: { val: 'float2', min: 'float2', max: 'float2' }, output: 'float2' },
    { inputs: { val: 'float3', min: 'float3', max: 'float3' }, output: 'float3' },
    { inputs: { val: 'float4', min: 'float4', max: 'float4' }, output: 'float4' },
    // Also support scalar clamping for vectors? GLSL does.
    // mix(genType x, genType minVal, genType maxVal)
    // mix(genType x, float minVal, float maxVal)
    { inputs: { val: 'float2', min: 'float', max: 'float' }, output: 'float2' },
    { inputs: { val: 'float3', min: 'float', max: 'float' }, output: 'float3' },
    { inputs: { val: 'float4', min: 'float', max: 'float' }, output: 'float4' },
  ],

  // Classification (Scalar Only? Or Vector?)
  // GLSL isinf/isnan returns bvec.
  'math_is_nan': genUnaryVariants('math_is_nan', 'boolean_vec'),
  'math_is_inf': genUnaryVariants('math_is_inf', 'boolean_vec'),
  'math_is_finite': genUnaryVariants('math_is_finite', 'boolean_vec'),

  'math_atan2': genMathVariants('math_atan2', 'same'), // y, x

  // Boolean Logic (Scalar Only usually? Or match hardware bvec?)
  // our 'boolean' type is distinct from 'float'.
  // If we want vec logic, we need to decide if input is 'vecN' (floats) or 'bvecN' (not existing).
  // User asked for "math_gt(vec, vec)".
  // For 'math_and', 'math_or', inputs are currently 'boolean'.
  // We don't have 'boolean vector' type.
  // So 'math_and' on vectors usually implies bitwise or logical on float representation (0.0/1.0).
  // Let's keep math_and/or scalar boolean for now unless requested.

  'math_and': [{ inputs: { a: 'boolean', b: 'boolean' }, output: 'boolean' }],
  'math_or': [{ inputs: { a: 'boolean', b: 'boolean' }, output: 'boolean' }],
  'math_xor': [{ inputs: { a: 'boolean', b: 'boolean' }, output: 'boolean' }],
  'math_not': [{ inputs: { val: 'boolean' }, output: 'boolean' }],

  // Casts
  'static_cast_int': [
    { inputs: { val: 'float' }, output: 'int' },
    { inputs: { val: 'boolean' }, output: 'int' }
  ],
  'static_cast_float': [
    { inputs: { val: 'int' }, output: 'float' },
    { inputs: { val: 'boolean' }, output: 'float' }
  ],
  'static_cast_bool': [
    { inputs: { val: 'int' }, output: 'boolean' },
    { inputs: { val: 'float' }, output: 'boolean' }
  ],
  // Vector casts
  'static_cast_int2': [{ inputs: { val: 'float2' }, output: 'int2' }],
  'static_cast_int3': [{ inputs: { val: 'float3' }, output: 'int3' }],
  'static_cast_int4': [{ inputs: { val: 'float4' }, output: 'int4' }],
  'static_cast_float2': [
    { inputs: { val: 'float2' }, output: 'float2' },
    { inputs: { val: 'int2' }, output: 'float2' }
  ],
  'static_cast_float3': [
    { inputs: { val: 'float3' }, output: 'float3' },
    { inputs: { val: 'int3' }, output: 'float3' }
  ],
  'static_cast_float4': [
    { inputs: { val: 'float4' }, output: 'float4' },
    { inputs: { val: 'int4' }, output: 'float4' }
  ],

  // Scalar Constructors
  'float': [{ inputs: { val: 'float' }, output: 'float' }],
  'int': [{ inputs: { val: 'int' }, output: 'int' }],
  'bool': [{ inputs: { val: 'boolean' }, output: 'boolean' }],

  // Vector Constructors
  'float2': [{ inputs: { x: 'float', y: 'float' }, output: 'float2' }],
  'float3': [{ inputs: { x: 'float', y: 'float', z: 'float' }, output: 'float3' }],
  'float4': [{ inputs: { x: 'float', y: 'float', z: 'float', w: 'float' }, output: 'float4' }],
  'int2': [{ inputs: { x: 'int', y: 'int' }, output: 'int2' }],
  'int3': [{ inputs: { x: 'int', y: 'int', z: 'int' }, output: 'int3' }],
  'int4': [{ inputs: { x: 'int', y: 'int', z: 'int', w: 'int' }, output: 'int4' }],

  'vec_get_element': [
    { inputs: { vec: 'float2', index: 'int' }, output: 'float' },
    { inputs: { vec: 'float3', index: 'int' }, output: 'float' },
    { inputs: { vec: 'float4', index: 'int' }, output: 'float' },
    { inputs: { vec: 'int2', index: 'int' }, output: 'int' },
    { inputs: { vec: 'int3', index: 'int' }, output: 'int' },
    { inputs: { vec: 'int4', index: 'int' }, output: 'int' },
    { inputs: { vec: 'float3x3', index: 'int' }, output: 'float' },
    { inputs: { vec: 'float4x4', index: 'int' }, output: 'float' }
  ],
  'vec_set_element': [
    { inputs: { vec: 'float2', index: 'int', value: 'float' }, output: 'any' },
    { inputs: { vec: 'float3', index: 'int', value: 'float' }, output: 'any' },
    { inputs: { vec: 'float4', index: 'int', value: 'float' }, output: 'any' },
    { inputs: { vec: 'int2', index: 'int', value: 'int' }, output: 'any' },
    { inputs: { vec: 'int3', index: 'int', value: 'int' }, output: 'any' },
    { inputs: { vec: 'int4', index: 'int', value: 'int' }, output: 'any' },
    { inputs: { vec: 'float3x3', index: 'int', value: 'float' }, output: 'any' },
    { inputs: { vec: 'float4x4', index: 'int', value: 'float' }, output: 'any' }
  ],
  'vec_swizzle': [
    { inputs: { vec: 'float2', channels: 'string' }, output: 'any' },
    { inputs: { vec: 'float3', channels: 'string' }, output: 'any' },
    { inputs: { vec: 'float4', channels: 'string' }, output: 'any' },
    { inputs: { vec: 'int2', channels: 'string' }, output: 'any' },
    { inputs: { vec: 'int3', channels: 'string' }, output: 'any' },
    { inputs: { vec: 'int4', channels: 'string' }, output: 'any' }
  ],

  // Vector Ops
  'vec_dot': [
    { inputs: { a: 'float2', b: 'float2' }, output: 'float' },
    { inputs: { a: 'float3', b: 'float3' }, output: 'float' },
    { inputs: { a: 'float4', b: 'float4' }, output: 'float' },
  ],
  'vec_mix': [
    { inputs: { a: 'float2', b: 'float2', t: 'float' }, output: 'float2' },
    { inputs: { a: 'float3', b: 'float3', t: 'float' }, output: 'float3' },
    { inputs: { a: 'float4', b: 'float4', t: 'float' }, output: 'float4' },
    // Element-wise mix (t is vector)
    { inputs: { a: 'float2', b: 'float2', t: 'float2' }, output: 'float2' },
    { inputs: { a: 'float3', b: 'float3', t: 'float3' }, output: 'float3' },
    { inputs: { a: 'float4', b: 'float4', t: 'float4' }, output: 'float4' },
  ],
  'vec_length': [
    { inputs: { a: 'float2' }, output: 'float' },
    { inputs: { a: 'float3' }, output: 'float' },
    { inputs: { a: 'float4' }, output: 'float' },
  ],
  'vec_normalize': [
    { inputs: { a: 'float2' }, output: 'float2' },
    { inputs: { a: 'float3' }, output: 'float3' },
    { inputs: { a: 'float4' }, output: 'float4' },
  ],

  // Matrix
  // Output Ops
  'literal': [{ inputs: { val: 'any' }, output: 'any' }], // Can return any type

  // Matrix
  'mat_identity': [{ inputs: { size: 'int' }, output: 'float4x4' }],
  'float4x4': [{ inputs: { '*': 'any' }, output: 'float4x4' }],
  'float3x3': [{ inputs: { '*': 'any' }, output: 'float3x3' }],
  'mat_transpose': [{ inputs: { val: 'any' }, output: 'any' }],
  'mat_inverse': [{ inputs: { val: 'any' }, output: 'any' }],
  'mat_extract': [{ inputs: { mat: 'any', col: 'int', row: 'int' }, output: 'float' }],
  'mat_mul': [
    { inputs: { a: 'float4x4', b: 'float4x4' }, output: 'float4x4' },
    { inputs: { a: 'float3x3', b: 'float3x3' }, output: 'float3x3' },
    { inputs: { a: 'float4x4', b: 'float4' }, output: 'float4' },
    { inputs: { a: 'float3x3', b: 'float3' }, output: 'float3' },
    { inputs: { a: 'float4', b: 'float4x4' }, output: 'float4' },
    { inputs: { a: 'float3', b: 'float3x3' }, output: 'float3' },
  ],

  // --- Missing Math ---
  'math_step': [
    { inputs: { edge: 'float', x: 'float' }, output: 'float' },
    { inputs: { edge: 'float2', x: 'float2' }, output: 'float2' },
    { inputs: { edge: 'float3', x: 'float3' }, output: 'float3' },
    { inputs: { edge: 'float4', x: 'float4' }, output: 'float4' },
    { inputs: { edge: 'float', x: 'float2' }, output: 'float2' },
    { inputs: { edge: 'float', x: 'float3' }, output: 'float3' },
    { inputs: { edge: 'float', x: 'float4' }, output: 'float4' }
  ],
  'math_smoothstep': [
    { inputs: { edge0: 'float', edge1: 'float', x: 'float' }, output: 'float' },
    { inputs: { edge0: 'float2', edge1: 'float2', x: 'float2' }, output: 'float2' },
    { inputs: { edge0: 'float3', edge1: 'float3', x: 'float3' }, output: 'float3' },
    { inputs: { edge0: 'float4', edge1: 'float4', x: 'float4' }, output: 'float4' },
    { inputs: { edge0: 'float', edge1: 'float', x: 'float2' }, output: 'float2' },
    { inputs: { edge0: 'float', edge1: 'float', x: 'float3' }, output: 'float3' },
    { inputs: { edge0: 'float', edge1: 'float', x: 'float4' }, output: 'float4' }
  ],
  'math_mix': [
    { inputs: { a: 'float', b: 'float', t: 'float' }, output: 'float' },
    { inputs: { a: 'float2', b: 'float2', t: 'float2' }, output: 'float2' },
    { inputs: { a: 'float3', b: 'float3', t: 'float3' }, output: 'float3' },
    { inputs: { a: 'float4', b: 'float4', t: 'float4' }, output: 'float4' },
    { inputs: { a: 'float2', b: 'float2', t: 'float' }, output: 'float2' },
    { inputs: { a: 'float3', b: 'float3', t: 'float' }, output: 'float3' },
    { inputs: { a: 'float4', b: 'float4', t: 'float' }, output: 'float4' },
    // Boolean mix (select)
    { inputs: { a: 'float', b: 'float', t: 'boolean' }, output: 'float' },
    { inputs: { a: 'float2', b: 'float2', t: 'boolean' }, output: 'float2' },
    { inputs: { a: 'float3', b: 'float3', t: 'boolean' }, output: 'float3' },
    { inputs: { a: 'float4', b: 'float4', t: 'boolean' }, output: 'float4' }
  ],
  'color_mix': [
    { inputs: { a: 'float4', b: 'float4', t: 'float' }, output: 'float4' },
    { inputs: { a: 'float4', b: 'float4' }, output: 'float4' }
  ],
  'math_pi': [{ inputs: {}, output: 'float' }],
  'math_e': [{ inputs: {}, output: 'float' }],

  // --- Quaternions ---
  'quat': [
    { inputs: { axis: 'float3', angle: 'float' }, output: 'float4' },
    { inputs: { x: 'float', y: 'float', z: 'float', w: 'float' }, output: 'float4' }
  ],
  'quat_identity': [{ inputs: {}, output: 'float4' }],
  'quat_mul': [{ inputs: { a: 'float4', b: 'float4' }, output: 'float4' }],
  'quat_slerp': [{ inputs: { a: 'float4', b: 'float4', t: 'float' }, output: 'float4' }],
  'quat_rotate': [{ inputs: { v: 'float3', q: 'float4' }, output: 'float3' }],
  'quat_to_float4x4': [{ inputs: { q: 'float4' }, output: 'float4x4' }],

  // System
  'struct_extract': [{ inputs: { struct: 'struct', field: 'string' }, output: 'any' }],
  'const_get': [{ inputs: { name: 'string' }, output: 'float' }],
  'buffer_load': [{ inputs: { buffer: 'string', index: 'int' }, output: 'any' }],
  'buffer_store': [{ inputs: { buffer: 'string', index: 'int', value: 'any' }, output: 'any' }],
  'var_set': [{ inputs: { var: 'string', val: 'any' }, output: 'any' }],
  'var_get': [{ inputs: { var: 'string' }, output: 'any' }],
  'loop_index': [{ inputs: { loop: 'string' }, output: 'int' }],
  'builtin_get': Object.entries(BUILTIN_TYPES).map(([name, type]) => ({
    inputs: { name: 'string' }, // We still use generic 'string' for inference, but resolveNodeType will use name
    output: type as ValidationType
  })),

  // Structs & Arrays
  'struct_construct': [
    { inputs: { type: 'string', values: 'any' }, output: 'any' },
    { inputs: { type: 'string', '*': 'any' }, output: 'any' },
    { inputs: { type: 'string' }, output: 'any' }
  ],

  'array_construct': [
    { inputs: { values: 'array' }, output: 'any' },
    { inputs: { values: 'array', type: 'string' }, output: 'any' },
    { inputs: { type: 'string', length: 'int', fill: 'any' }, output: 'any' },
    { inputs: { type: 'string', values: 'array' }, output: 'any' },
    { inputs: { '*': 'any' }, output: 'any' }
  ],
  'array_set': [{ inputs: { array: 'any', index: 'int', value: 'any' }, output: 'any' }],
  'array_extract': [{ inputs: { array: 'any', index: 'int' }, output: 'any' }],
  'array_length': [{ inputs: { array: 'any' }, output: 'int' }],

  // Control Flow
  'call_func': [
    { inputs: { func: 'string' }, output: 'any' },
    { inputs: { func: 'string', args: 'any' }, output: 'any' },
    { inputs: { func: 'string', '*': 'any' }, output: 'any' }
  ],

  'func_return': [
    { inputs: { val: 'any' }, output: 'any' },
    { inputs: {}, output: 'any' }
  ],
  'flow_branch': [{ inputs: { cond: 'boolean' }, output: 'any' }],
  'flow_loop': [
    { inputs: { start: 'int', end: 'int' }, output: 'any' },
    { inputs: { count: 'int' }, output: 'any' }
  ],

  // Resources
  'resource_get_size': [{ inputs: { resource: 'string' }, output: 'float2' }],
  'resource_get_format': [{ inputs: { resource: 'string' }, output: 'int' }], // Fixed: id -> resource
  'texture_sample': [
    { inputs: { tex: 'string', coords: 'float2' }, output: 'float4' }
  ],
  'texture_load': [{ inputs: { tex: 'string', coords: 'float2' }, output: 'float4' }],
  'texture_store': [{ inputs: { tex: 'string', coords: 'float2', value: 'float4' }, output: 'any' }],

  // Commands
  'cmd_dispatch': [
    { inputs: { func: 'string' }, output: 'any' },
    { inputs: { func: 'string', dispatch: 'float3' }, output: 'any' },
    { inputs: { func: 'string', dispatch: 'int' }, output: 'any' },
    { inputs: { func: 'string', dispatch: 'any', args: 'any' }, output: 'any' },
    { inputs: { func: 'string', args: 'any' }, output: 'any' },
    { inputs: { func: 'string', '*': 'any' }, output: 'any' }
  ],
  'cmd_resize_resource': [
    { inputs: { resource: 'string', size: 'any' }, output: 'any' },
    { inputs: { resource: 'string', size: 'any', clear: 'any' }, output: 'any' } // Added optional clear
  ],
  'cmd_draw': [
    { inputs: { target: 'string', vertex: 'string', fragment: 'string', count: 'int', pipeline: 'any' }, output: 'any' },
    { inputs: { target: 'string', vertex: 'string', fragment: 'string', count: 'int' }, output: 'any' }
  ],
  'cmd_sync_to_cpu': [{ inputs: { resource: 'string' }, output: 'any' }],
  'cmd_wait_cpu_sync': [{ inputs: { resource: 'string' }, output: 'any' }]
};
