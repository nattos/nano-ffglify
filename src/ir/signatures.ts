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

export const OpSignatures: Partial<Record<BuiltinOp, OpSignature[]>> = {
  // ----------------------------------------------------------------
  // Math (Scalar)
  // ----------------------------------------------------------------
  'math_add': [{ inputs: { a: 'number', b: 'number' }, output: 'number' }],
  'math_sub': [{ inputs: { a: 'number', b: 'number' }, output: 'number' }],
  'math_mul': [{ inputs: { a: 'number', b: 'number' }, output: 'number' }],
  'math_div': [{ inputs: { a: 'number', b: 'number' }, output: 'number' }],
  'math_mod': [{ inputs: { a: 'number', b: 'number' }, output: 'number' }],

  'math_clamp': [{ inputs: { val: 'number', min: 'number', max: 'number' }, output: 'number' }],

  // ----------------------------------------------------------------
  // Logic
  // ----------------------------------------------------------------
  'math_gt': [{ inputs: { a: 'number', b: 'number' }, output: 'boolean' }],
  'math_lt': [{ inputs: { a: 'number', b: 'number' }, output: 'boolean' }],
  'math_ge': [{ inputs: { a: 'number', b: 'number' }, output: 'boolean' }],
  'math_le': [{ inputs: { a: 'number', b: 'number' }, output: 'boolean' }],
  'math_eq': [{ inputs: { a: 'number', b: 'number' }, output: 'boolean' }],
  'math_neq': [{ inputs: { a: 'number', b: 'number' }, output: 'boolean' }],

  'math_and': [{ inputs: { a: 'boolean', b: 'boolean' }, output: 'boolean' }],
  'math_or': [{ inputs: { a: 'boolean', b: 'boolean' }, output: 'boolean' }],
  'math_xor': [{ inputs: { a: 'boolean', b: 'boolean' }, output: 'boolean' }],
  'math_not': [{ inputs: { val: 'boolean' }, output: 'boolean' }],

  // ----------------------------------------------------------------
  // Vector Constructors & Access
  // ----------------------------------------------------------------
  'vec2': [{ inputs: { x: 'number', y: 'number' }, output: 'vec2' }],
  'vec3': [{ inputs: { x: 'number', y: 'number', z: 'number' }, output: 'vec3' }],
  'vec4': [{ inputs: { x: 'number', y: 'number', z: 'number', w: 'number' }, output: 'vec4' }],

  // 'vec_get_element' could be overloaded or generic?
  // Simulating overloads for types:
  'vec_get_element': [
    { inputs: { vec: 'vec2', index: 'int' }, output: 'number' },
    { inputs: { vec: 'vec3', index: 'int' }, output: 'number' },
    { inputs: { vec: 'vec4', index: 'int' }, output: 'number' }
  ],

  // ----------------------------------------------------------------
  // Vector Math (Strict Overloads)
  // ----------------------------------------------------------------
  'vec_dot': [
    { inputs: { a: 'vec2', b: 'vec2' }, output: 'number' },
    { inputs: { a: 'vec3', b: 'vec3' }, output: 'number' },
    { inputs: { a: 'vec4', b: 'vec4' }, output: 'number' },
  ],

  // Mix
  'vec_mix': [
    { inputs: { a: 'vec2', b: 'vec2', t: 'number' }, output: 'vec2' },
    { inputs: { a: 'vec3', b: 'vec3', t: 'number' }, output: 'vec3' },
    { inputs: { a: 'vec4', b: 'vec4', t: 'number' }, output: 'vec4' },
  ],

  // Length / Normalize
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

  // ----------------------------------------------------------------
  // Matrix (Strict)
  // ----------------------------------------------------------------
  'mat_identity': [
    { inputs: { size: 'int' }, output: 'mat4' } // Assumes 4 default? Only valid for 3/4?
    // Actually size=3 -> mat3
  ],

  'mat_mul': [
    // Mat x Mat
    { inputs: { a: 'mat4', b: 'mat4' }, output: 'mat4' },
    { inputs: { a: 'mat3', b: 'mat3' }, output: 'mat3' },
    // Mat x Vec
    { inputs: { a: 'mat4', b: 'vec4' }, output: 'vec4' },
    { inputs: { a: 'mat3', b: 'vec3' }, output: 'vec3' },
    // Vec x Mat
    { inputs: { a: 'vec4', b: 'mat4' }, output: 'vec4' },
    { inputs: { a: 'vec3', b: 'mat3' }, output: 'vec3' },
  ],

  // ----------------------------------------------------------------
  // System / Resources
  // ----------------------------------------------------------------
  'struct_extract': [{ inputs: { struct: 'struct', field: 'string' }, output: 'any' }],
  'const_get': [{ inputs: { name: 'string' }, output: 'number' }], // Or int? usually enums are int.

  'buffer_load': [{ inputs: { buffer: 'string', index: 'int' }, output: 'any' }], // buffer data is any
  'buffer_store': [{ inputs: { buffer: 'string', index: 'int', value: 'any' }, output: 'any' }], // void?

  'var_set': [{ inputs: { var: 'string', val: 'any' }, output: 'any' }], // Pass-through
  'var_get': [{ inputs: { var: 'string' }, output: 'any' }],

  // Loop Index
  'loop_index': [{ inputs: { loop: 'string' }, output: 'int' }]
};
