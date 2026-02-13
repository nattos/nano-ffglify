import { describe, it, expect } from 'vitest';
import { validateIR } from '../../ir/validator';
import { IRDocument } from '../../ir/types';

describe('Strict Type Validation', () => {
  it('should reject f32 as a primitive type', () => {
    const ir: IRDocument = {
      version: '1.0',
      meta: { name: 'invalid-type' },
      entryPoint: 'main',
      inputs: [
        { id: 'foo', type: 'f32' }
      ],
      functions: [
        {
          id: 'main',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'n1', op: 'literal', val: 0 }
          ]
        }
      ],
      resources: [],
      structs: []
    };

    const errors = validateIR(ir);
    expect(errors.some(e => e.message.includes("Invalid data type 'f32'"))).toBe(true);
  });

  it('should reject i32 in arrays', () => {
    const ir: IRDocument = {
      version: '1.0',
      meta: { name: 'invalid-array' },
      entryPoint: 'main',
      inputs: [
        { id: 'foo', type: 'array<i32, 10>' }
      ],
      functions: [
        {
          id: 'main',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'n1', op: 'literal', val: 0 }
          ]
        }
      ],
      resources: [],
      structs: []
    };

    const errors = validateIR(ir);
    expect(errors.some(e => e.message.includes("Invalid data type 'i32'"))).toBe(true);
  });

  it('should reject invalid array syntax', () => {
    const ir: IRDocument = {
      version: '1.0',
      meta: { name: 'invalid-syntax' },
      entryPoint: 'main',
      inputs: [
        { id: 'foo', type: 'array<float>' } // missing comma or closing
      ],
      functions: [
        {
          id: 'main',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'n1', op: 'literal', val: 0 }
          ]
        }
      ],
      resources: [],
      structs: []
    };

    const errors = validateIR(ir);
    expect(errors.some(e => e.message.includes("Invalid array syntax"))).toBe(true);
  });

  it('should accept official types', () => {
    const ir: IRDocument = {
      version: '1.0',
      meta: { name: 'valid-types' },
      entryPoint: 'main',
      inputs: [
        { id: 'f', type: 'float' },
        { id: 'i', type: 'int' },
        { id: 'u', type: 'int' },
        { id: 'b', type: 'bool' },
        { id: 'a', type: 'array<float, 4>' }
      ],
      functions: [
        {
          id: 'main',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'n1', op: 'literal', val: 0 }
          ]
        }
      ],
      resources: [],
      structs: []
    };

    const errors = validateIR(ir);
    // Filter out entry point not found if any, though it's there
    expect(errors.filter(e => e.severity === 'error').length).toBe(0);
  });
});
