
import { describe, it, expect } from 'vitest';
import { validateIR } from '../../ir/validator';
import { IRDocument, FunctionDef } from '../../ir/types';

describe('Validator Coercion Rules', () => {

  const createIR = (nodes: any[], structs?: any[]): IRDocument => ({
    entryPoint: 'main',
    functions: [{
      id: 'main',
      type: 'shader',
      stage: 'fragment',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        ...nodes,
        { id: 'ret', op: 'func_return' }
      ]
    }],
    resources: [],
    inputs: [],
    structs: structs || []
  });

  const getFunction = (doc: IRDocument) => doc.functions[0];

  it('should allow implicit float/int coercion (Supported)', () => {
    const ir = createIR([
      { id: 'n1', op: 'literal', val: 1.5 }, // float
      { id: 'n2', op: 'literal', val: 2 },   // int (in node def it is number, inferred as float/int)
      // math_add expects (T, T). Validator allows (float, int) mismatch.
      { id: 'add', op: 'math_add', a: 'n1', b: 'n2' }
    ]);

    const errors = validateIR(ir);
    expect(errors).toHaveLength(0);
  });

  it('should FAIL validation for float/boolean mismatch (Unsupported)', () => {
    const ir = createIR([
      { id: 'n1', op: 'literal', val: 1.5 }, // float
      { id: 'n2', op: 'literal', val: true }, // boolean
      // math_add does not support (float, boolean)
      { id: 'add', op: 'math_add', a: 'n1', b: 'n2' }
    ]);

    const errors = validateIR(ir);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Type Mismatch/);
    expect(errors[0].nodeId).toBe('add');
  });

  it('should FAIL validation for dimension mismatch (float2 vs float3)', () => {
    const ir = createIR([
      { id: 'v2', op: 'array_construct', values: [1, 2] }, // float2
      { id: 'v3', op: 'array_construct', values: [1, 2, 3] }, // float3
      // math_add expects (T, T) or (T, float). float2 + float3 is invalid.
      { id: 'add', op: 'math_add', a: 'v2', b: 'v3' }
    ]);

    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/Type Mismatch/);
  });

  it('should allow vector broadcasting (Supported)', () => {
    const ir = createIR([
      { id: 'v3', op: 'array_construct', values: [1, 2, 3] }, // float3
      { id: 's', op: 'literal', val: 2.0 }, // float
      // math_mul supports (vec, scalar)
      { id: 'mul', op: 'math_mul', a: 'v3', b: 's' }
    ]);

    const errors = validateIR(ir);
    expect(errors).toHaveLength(0);
  });

  it('should enforce strict type for buffer_store (float buffer, int value)', () => {
    // This requires a resource definition
    const ir: IRDocument = {
      entryPoint: 'main',
      resources: [
        { id: 'buf', type: 'buffer', dataType: 'float' }
      ],
      inputs: [],
      structs: [],
      functions: [{
        id: 'main',
        type: 'shader',
        stage: 'compute',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'idx', op: 'literal', val: 0 },
          { id: 'val', op: 'literal', val: 5 }, // int 5
          // buffer_store expects strict float
          // Note: In JS '5' is number=float. But let's try to simulate implicit int.
          // Validator infers literal number as 'float'.
          // Wait, if I want to simulate INT input, I need an op that returns int, or 'literal' int logic?
          // Validator.ts: literal number -> 'float'.
          // To test strictness, let's use a boolean or explicit int cast if possible?
          // There is 'static_cast_int' which returns 'int'.
          { id: 'int_val', op: 'static_cast_int', val: 'idx' }, // returns int
          { id: 'store', op: 'buffer_store', buffer: 'buf', index: 'idx', value: 'int_val' },
          { id: 'ret', op: 'func_return' }
        ]
      }]
    };

    const errors = validateIR(ir);
    // buffer_store logic in validator.ts checks: if (actual !== expected) error.
    // actual='int', expected='float'.
    // It specifically mentions: "strict type casting (e.g. i32 -> f32) in generation implies implicit is BAD."
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Type Mismatch in buffer_store/);
  });

  it('should enforce signature check for texture_store', () => {
    const ir: IRDocument = {
      entryPoint: 'main',
      resources: [
        { id: 'tex', type: 'texture2d', format: 'rgba8' }
      ],
      inputs: [],
      structs: [],
      functions: [{
        id: 'main',
        type: 'shader',
        stage: 'compute',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'coords', op: 'array_construct', values: [0, 0] }, // float2
          { id: 'val3', op: 'array_construct', values: [1, 0, 1] }, // float3
          // texture_store expects float4 value
          { id: 'store', op: 'texture_store', tex: 'tex', coords: 'coords', value: 'val3' },
          { id: 'ret', op: 'func_return' }
        ]
      }]
    };

    const errors = validateIR(ir);
    // This fails via general signature mismatch in resolveNodeType -> OpSignatures check
    expect(errors.length).toBeGreaterThan(0);
    // Should contain "Type Mismatch"
    const hasMismatch = errors.some(e => e.message.includes('Type Mismatch'));
    // Or "Missing required argument" if it falls through
    // But here we expect mismatched type for 'value' input
    expect(hasMismatch).toBe(true);
  });

  describe('Struct and Array Inference', () => {
    it('should infer struct_construct type from its type property', () => {
      const ir = createIR([
        { id: 'v2', op: 'float2', x: 1, y: 2 },
        { id: 's', op: 'struct_construct', type: 'Point', values: { x: 1, y: 'v2' } }
      ], [
        { id: 'Point', members: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float2' }] }
      ]);

      const errors = validateIR(ir);
      expect(errors).toHaveLength(0);
      // We can't easily check the cache from here without exposing it,
      // but if it validates, it means it didn't return 'any'.
    });

    it('should infer array_construct element type from fill (float)', () => {
      const ir = createIR([
        { id: 'arr', op: 'array_construct', length: 3, fill: 0.0 }
      ]);
      const errors = validateIR(ir);
      expect(errors).toHaveLength(0);
    });

    it('should infer array_construct element type from fill (struct reference)', () => {
      const ir = createIR([
        { id: 'p', op: 'struct_construct', type: 'Point', values: { val: 1 } },
        { id: 'arr', op: 'array_construct', length: 2, fill: 'p' }
      ], [
        { id: 'Point', members: [{ name: 'val', type: 'float' }] }
      ]);
      const errors = validateIR(ir);
      expect(errors).toHaveLength(0);
    });

    it('should infer array_construct element type from values array', () => {
      const ir = createIR([
        { id: 'arr', op: 'array_construct', values: [1.1, 2.2, 3.3] }
      ]);
      const errors = validateIR(ir);
      expect(errors).toHaveLength(0);
    });

    it('should handle nested struct array inference', () => {
      const ir = createIR([
        { id: 'p1', op: 'struct_construct', type: 'Point', values: { v: 1 } },
        { id: 'p2', op: 'struct_construct', type: 'Point', values: { v: 2 } },
        { id: 'arr', op: 'array_construct', values: ['p1', 'p2'] }
      ], [
        { id: 'Point', members: [{ name: 'v', type: 'float' }] }
      ]);
      const errors = validateIR(ir);
      expect(errors).toHaveLength(0);
    });
  });

});
