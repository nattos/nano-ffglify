import { BuiltinOp, DataType } from './types';

export interface PortSignature {
  type: DataType | 'vector' | 'any'; // 'vector' implies number[]
  required?: boolean;
}

export interface OpSignature {
  inputs: Record<string, PortSignature>;
  outputs?: DataType | 'vector' | 'any';
}

// Partial map of signatures for common ops
export const OpSignatures: Partial<Record<BuiltinOp, OpSignature>> = {
  // Math
  'math_add': { inputs: { a: { type: 'number' }, b: { type: 'number' } }, outputs: 'number' },
  'math_sub': { inputs: { a: { type: 'number' }, b: { type: 'number' } }, outputs: 'number' },
  'math_mul': { inputs: { a: { type: 'number' }, b: { type: 'number' } }, outputs: 'number' },
  'math_div': { inputs: { a: { type: 'number' }, b: { type: 'number' } }, outputs: 'number' },

  // Logic
  'math_gt': { inputs: { a: { type: 'number' }, b: { type: 'number' } }, outputs: 'boolean' },

  // Vector
  'vec2': { inputs: { x: { type: 'number' }, y: { type: 'number' } }, outputs: 'vector' },
  'vec3': { inputs: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, outputs: 'vector' },
  'vec4': { inputs: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' } }, outputs: 'vector' },
  'vec_dot': { inputs: { a: { type: 'vector' }, b: { type: 'vector' } }, outputs: 'number' },
  'vec_mix': { inputs: { a: { type: 'vector' }, b: { type: 'vector' }, t: { type: 'number' } }, outputs: 'vector' },

  // Matrix
  'mat_mul': { inputs: { a: { type: 'vector' }, b: { type: 'vector' } }, outputs: 'vector' },
  'mat_identity': { inputs: { size: { type: 'number' } }, outputs: 'vector' },

  // Validations for Structs/Arrays require strict 'struct' or 'array' type?
  // currently DataType includes 'struct', 'array'.
  'struct_extract': { inputs: { struct: { type: 'struct' }, field: { type: 'string' } }, outputs: 'any' },
  'array_set': { inputs: { array: { type: 'array' }, index: { type: 'number' }, value: { type: 'any' } }, outputs: 'any' },

  // Resources
  'buffer_store': { inputs: { buffer: { type: 'string' }, index: { type: 'number' }, value: { type: 'any' } } },
  'buffer_load': { inputs: { buffer: { type: 'string' }, index: { type: 'number' } }, outputs: 'any' },

  // Const
  'const_get': { inputs: { name: { type: 'string' } }, outputs: 'number' },

  // Flow
  'var_set': { inputs: { var: { type: 'string' }, val: { type: 'any' } }, outputs: 'any' },
  'var_get': { inputs: { var: { type: 'string' } }, outputs: 'any' }
};
