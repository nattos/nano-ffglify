import { BuiltinOp } from './types';

export type ValidationType =
  | 'number'  // Generic scalar (float)
  | 'int'     // Integer (for loops, strict checks)
  | 'boolean'
  | 'string'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'mat3'
  | 'mat4'
  | 'struct' // Generic Struct
  | 'array'  // Generic Array
  | 'any';   // Fallback

export interface OpSignature {
  inputs: Record<string, ValidationType>;
  output: ValidationType;
}

const genMathVariants = (op: BuiltinOp, returnType: 'same' | 'boolean_vec'): OpSignature[] => {
  const types: ValidationType[] = ['number', 'vec2', 'vec3', 'vec4'];
  return types.map(t => {
    let out = t;
    if (returnType === 'boolean_vec') {
      // Scalar -> boolean
      // Vector -> Vector (of 0.0/1.0)
      out = (t === 'number') ? 'boolean' : t;
    }
    return { inputs: { a: t, b: t }, output: out };
  });
};

const genUnaryVariants = (op: BuiltinOp, returnType: 'same' | 'boolean_vec'): OpSignature[] => {
  const types: ValidationType[] = ['number', 'vec2', 'vec3', 'vec4'];
  return types.map(t => {
    let out = t;
    if (returnType === 'boolean_vec') {
      out = (t === 'number') ? 'boolean' : t;
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
const signatures: Partial<Record<BuiltinOp, OpSignature[]>> = {};

MATH_OPS.forEach(op => signatures[op] = genMathVariants(op, 'same'));
LOGIC_OPS.forEach(op => signatures[op] = genMathVariants(op, 'boolean_vec'));
UNARY_OPS.forEach(op => signatures[op] = genUnaryVariants(op, 'same'));

export const OpSignatures: Partial<Record<BuiltinOp, OpSignature[]>> = {
  ...signatures,

  'math_mad': [
    { inputs: { a: 'number', b: 'number', c: 'number' }, output: 'number' },
    { inputs: { a: 'vec2', b: 'vec2', c: 'vec2' }, output: 'vec2' },
    { inputs: { a: 'vec3', b: 'vec3', c: 'vec3' }, output: 'vec3' },
    { inputs: { a: 'vec4', b: 'vec4', c: 'vec4' }, output: 'vec4' },
  ],

  'math_clamp': [
    { inputs: { val: 'number', min: 'number', max: 'number' }, output: 'number' },
    { inputs: { val: 'vec2', min: 'vec2', max: 'vec2' }, output: 'vec2' },
    { inputs: { val: 'vec3', min: 'vec3', max: 'vec3' }, output: 'vec3' },
    { inputs: { val: 'vec4', min: 'vec4', max: 'vec4' }, output: 'vec4' },
    // Also support scalar clamping for vectors? GLSL does.
    // mix(genType x, genType minVal, genType maxVal)
    // mix(genType x, float minVal, float maxVal)
    { inputs: { val: 'vec2', min: 'number', max: 'number' }, output: 'vec2' },
    { inputs: { val: 'vec3', min: 'number', max: 'number' }, output: 'vec3' },
    { inputs: { val: 'vec4', min: 'number', max: 'number' }, output: 'vec4' },
  ],

  // Classification (Scalar Only? Or Vector?)
  // GLSL isinf/isnan returns bvec.
  'math_is_nan': genUnaryVariants('math_is_nan', 'boolean_vec'),
  'math_is_inf': genUnaryVariants('math_is_inf', 'boolean_vec'),
  'math_is_finite': genUnaryVariants('math_is_finite', 'boolean_vec'),

  'math_atan2': genMathVariants('math_atan2', 'same'), // y, x

  // Boolean Logic (Scalar Only usually? Or match hardware bvec?)
  // our 'boolean' type is distinct from 'number'.
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
    { inputs: { val: 'number' }, output: 'int' },
    { inputs: { val: 'boolean' }, output: 'int' }
  ],
  'static_cast_float': [
    { inputs: { val: 'int' }, output: 'number' },
    { inputs: { val: 'boolean' }, output: 'number' }
  ],
  'static_cast_bool': [
    { inputs: { val: 'int' }, output: 'boolean' },
    { inputs: { val: 'number' }, output: 'boolean' }
  ],

  // Vector Constructors
  'vec2': [{ inputs: { x: 'number', y: 'number' }, output: 'vec2' }],
  'vec3': [{ inputs: { x: 'number', y: 'number', z: 'number' }, output: 'vec3' }],
  'vec4': [{ inputs: { x: 'number', y: 'number', z: 'number', w: 'number' }, output: 'vec4' }],

  'vec_get_element': [
    { inputs: { vec: 'vec2', index: 'int' }, output: 'number' },
    { inputs: { vec: 'vec3', index: 'int' }, output: 'number' },
    { inputs: { vec: 'vec4', index: 'int' }, output: 'number' }
  ],
  'vec_swizzle': [
    { inputs: { val: 'vec2', mask: 'string' }, output: 'any' },
    { inputs: { val: 'vec3', mask: 'string' }, output: 'any' },
    { inputs: { val: 'vec4', mask: 'string' }, output: 'any' }
  ],

  // Vector Ops
  'vec_dot': [
    { inputs: { a: 'vec2', b: 'vec2' }, output: 'number' },
    { inputs: { a: 'vec3', b: 'vec3' }, output: 'number' },
    { inputs: { a: 'vec4', b: 'vec4' }, output: 'number' },
  ],
  'vec_mix': [
    { inputs: { a: 'vec2', b: 'vec2', t: 'number' }, output: 'vec2' },
    { inputs: { a: 'vec3', b: 'vec3', t: 'number' }, output: 'vec3' },
    { inputs: { a: 'vec4', b: 'vec4', t: 'number' }, output: 'vec4' },
    // Element-wise mix (t is vector)
    { inputs: { a: 'vec2', b: 'vec2', t: 'vec2' }, output: 'vec2' },
    { inputs: { a: 'vec3', b: 'vec3', t: 'vec3' }, output: 'vec3' },
    { inputs: { a: 'vec4', b: 'vec4', t: 'vec4' }, output: 'vec4' },
  ],
  'vec_length': [
    { inputs: { a: 'vec2' }, output: 'number' },
    { inputs: { a: 'vec3' }, output: 'number' },
    { inputs: { a: 'vec4' }, output: 'number' },
  ],
  'vec_normalize': [
    { inputs: { a: 'vec2' }, output: 'vec2' },
    { inputs: { a: 'vec3' }, output: 'vec3' },
    { inputs: { a: 'vec4' }, output: 'vec4' },
  ],

  // Matrix
  'mat_identity': [{ inputs: { size: 'int' }, output: 'mat4' }],
  'mat_mul': [
    { inputs: { a: 'mat4', b: 'mat4' }, output: 'mat4' },
    { inputs: { a: 'mat3', b: 'mat3' }, output: 'mat3' },
    { inputs: { a: 'mat4', b: 'vec4' }, output: 'vec4' },
    { inputs: { a: 'mat3', b: 'vec3' }, output: 'vec3' },
    { inputs: { a: 'vec4', b: 'mat4' }, output: 'vec4' },
    { inputs: { a: 'vec3', b: 'mat3' }, output: 'vec3' },
  ],

  // System
  'struct_extract': [{ inputs: { struct: 'struct', field: 'string' }, output: 'any' }],
  'const_get': [{ inputs: { name: 'string' }, output: 'number' }],
  'buffer_load': [{ inputs: { buffer: 'string', index: 'int' }, output: 'any' }],
  'buffer_store': [{ inputs: { buffer: 'string', index: 'int', value: 'any' }, output: 'any' }],
  'var_set': [{ inputs: { var: 'string', val: 'any' }, output: 'any' }],
  'var_get': [{ inputs: { var: 'string' }, output: 'any' }],
  'loop_index': [{ inputs: { loop: 'string' }, output: 'int' }]
};
