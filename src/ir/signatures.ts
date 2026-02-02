import { BuiltinOp } from './types';

export type ValidationType =
  | 'float'  // Generic scalar (float)
  | 'int'     // Integer (for loops, strict checks)
  | 'boolean'
  | 'string'
  | 'float2'
  | 'float3'
  | 'float4'
  | 'float3x3'
  | 'float4x4'
  | 'struct' // Generic Struct
  | 'array'  // Generic Array
  | 'any';   // Fallback

export interface OpSignature {
  inputs: Record<string, ValidationType>;
  output: ValidationType;
}

const genMathVariants = (op: BuiltinOp, returnType: 'same' | 'boolean_vec'): OpSignature[] => {
  const types: ValidationType[] = ['float', 'float2', 'float3', 'float4'];
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
  }

  return variants;
};

const genUnaryVariants = (op: BuiltinOp, returnType: 'same' | 'boolean_vec'): OpSignature[] => {
  const types: ValidationType[] = ['float', 'float2', 'float3', 'float4'];
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
  'math_abs', 'math_ceil', 'math_floor',
  'math_fract', 'math_trunc',
  'math_flush_subnormal', 'math_mantissa', 'math_exponent'
];

// Helper to merge
const signatures: Partial<Record<BuiltinOp, OpSignature[]>> = {
  'math_div_scalar': [
    { inputs: { val: 'float', scalar: 'float' }, output: 'float' },
    { inputs: { val: 'float2', scalar: 'float' }, output: 'float2' },
    { inputs: { val: 'float3', scalar: 'float' }, output: 'float3' },
    { inputs: { val: 'float4', scalar: 'float' }, output: 'float4' },
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
    { inputs: { a: 'float4', b: 'float4', c: 'float4' }, output: 'float4' },
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

  // Scalar Constructors
  'float': [{ inputs: { val: 'float' }, output: 'float' }],
  'int': [{ inputs: { val: 'int' }, output: 'int' }],
  'bool': [{ inputs: { val: 'boolean' }, output: 'boolean' }],

  // Vector Constructors
  'float2': [{ inputs: { x: 'float', y: 'float' }, output: 'float2' }],
  'float3': [{ inputs: { x: 'float', y: 'float', z: 'float' }, output: 'float3' }],
  'float4': [{ inputs: { x: 'float', y: 'float', z: 'float', w: 'float' }, output: 'float4' }],

  'vec_get_element': [
    { inputs: { vec: 'float2', index: 'int' }, output: 'float' },
    { inputs: { vec: 'float3', index: 'int' }, output: 'float' },
    { inputs: { vec: 'float4', index: 'int' }, output: 'float' }
  ],
  'vec_swizzle': [
    { inputs: { vec: 'float2', channels: 'string' }, output: 'any' },
    { inputs: { vec: 'float3', channels: 'string' }, output: 'any' },
    { inputs: { vec: 'float4', channels: 'string' }, output: 'any' }
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
  'mat_identity': [{ inputs: { size: 'int' }, output: 'float4x4' }],
  'mat_mul': [
    { inputs: { a: 'float4x4', b: 'float4x4' }, output: 'float4x4' },
    { inputs: { a: 'float3x3', b: 'float3x3' }, output: 'float3x3' },
    { inputs: { a: 'float4x4', b: 'float4' }, output: 'float4' },
    { inputs: { a: 'float3x3', b: 'float3' }, output: 'float3' },
    { inputs: { a: 'float4', b: 'float4x4' }, output: 'float4' },
    { inputs: { a: 'float3', b: 'float3x3' }, output: 'float3' },
  ],

  // System
  'struct_extract': [{ inputs: { struct: 'struct', field: 'string' }, output: 'any' }],
  'const_get': [{ inputs: { name: 'string' }, output: 'float' }],
  'buffer_load': [{ inputs: { buffer: 'string', index: 'int' }, output: 'any' }],
  'buffer_store': [{ inputs: { buffer: 'string', index: 'int', value: 'any' }, output: 'any' }],
  'var_set': [{ inputs: { var: 'string', val: 'any' }, output: 'any' }],
  'var_get': [{ inputs: { var: 'string' }, output: 'any' }],
  'loop_index': [{ inputs: { loop: 'string' }, output: 'int' }]
};
