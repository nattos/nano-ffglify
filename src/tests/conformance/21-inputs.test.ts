import { describe, expect, it } from 'vitest';
import { buildSimpleIR, availableBackends } from './test-runner';
import { EvaluationContext } from '../../interpreter/context';

describe('Conformance: Inputs', () => {

  const bufferRes = {
    id: 'b_result',
    type: 'buffer',
    dataType: 'float',
    size: { mode: 'fixed', value: 16 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
  };

  const runInputTest = (
    name: string,
    inputsDef: { id: string, type: string }[],
    inputValues: Record<string, any>,
    nodes: any[],
    verify: (ctx: EvaluationContext) => void,
    localVars: any[] = []
  ) => {
    availableBackends.forEach(backend => {
      it(`${name} [${backend.name}]`, async () => {
        const globalVars = inputsDef;
        // Construct IR with distinct 'main' function
        const ir = buildSimpleIR(name, nodes, [bufferRes], [], localVars, [], globalVars);

        const inputsMap = new Map<string, any>(Object.entries(inputValues));
        const ctx = await backend.execute(ir, 'main', inputsMap);
        try {
          await verify(ctx);
        } finally {
          ctx.destroy();
        }
      });
    });
  };

  // 1. Float Scalar
  runInputTest(
    'should handle float scalar input',
    [{ id: 'u_float', type: 'float' }],
    { u_float: 123.456 },
    [
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'u_float' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(123.456, 4);
    }
  );

  // 2. Float Vector 2
  runInputTest(
    'should handle float2 input',
    [{ id: 'u_vec2', type: 'float2' }],
    { u_vec2: [1.5, 2.5] },
    [
      { id: 'x', op: 'vec_get_element', vec: 'u_vec2', index: 0 },
      { id: 'y', op: 'vec_get_element', vec: 'u_vec2', index: 1 },
      { id: 's0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'x' },
      { id: 's1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'y' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(1.5, 4);
      expect(res.data?.[1]).toBeCloseTo(2.5, 4);
    }
  );

  // 3. Float Vector 3
  runInputTest(
    'should handle float3 input',
    [{ id: 'u_vec3', type: 'float3' }],
    { u_vec3: [10.1, 20.2, 30.3] },
    [
      { id: 'x', op: 'vec_get_element', vec: 'u_vec3', index: 0 },
      { id: 'y', op: 'vec_get_element', vec: 'u_vec3', index: 1 },
      { id: 'z', op: 'vec_get_element', vec: 'u_vec3', index: 2 },
      { id: 's0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'x' },
      { id: 's1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'y' },
      { id: 's2', op: 'buffer_store', buffer: 'b_result', index: 2, value: 'z' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(10.1, 4);
      expect(res.data?.[1]).toBeCloseTo(20.2, 4);
      expect(res.data?.[2]).toBeCloseTo(30.3, 4);
    }
  );

  // 4. Float Vector 4
  runInputTest(
    'should handle float4 input',
    [{ id: 'u_vec4', type: 'float4' }],
    { u_vec4: [0.1, 0.2, 0.3, 0.4] },
    [
      { id: 'x', op: 'vec_get_element', vec: 'u_vec4', index: 0 },
      { id: 'y', op: 'vec_get_element', vec: 'u_vec4', index: 1 },
      { id: 'z', op: 'vec_get_element', vec: 'u_vec4', index: 2 },
      { id: 'w', op: 'vec_get_element', vec: 'u_vec4', index: 3 },
      { id: 's0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'x' },
      { id: 's1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'y' },
      { id: 's2', op: 'buffer_store', buffer: 'b_result', index: 2, value: 'z' },
      { id: 's3', op: 'buffer_store', buffer: 'b_result', index: 3, value: 'w' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(0.1, 4);
      expect(res.data?.[1]).toBeCloseTo(0.2, 4);
      expect(res.data?.[2]).toBeCloseTo(0.3, 4);
      expect(res.data?.[3]).toBeCloseTo(0.4, 4);
    }
  );

  // 5. Float Matrix 4x4
  runInputTest(
    'should handle float4x4 input (access via element get)',
    [{ id: 'u_mat4', type: 'float4x4' }],
    {
      u_mat4: [
        1, 2, 3, 4,
        5, 6, 7, 8,
        9, 10, 11, 12,
        13, 14, 15, 16
      ]
    },
    [
      // Extract indices 0, 5, 10, 15 (diagonal)
      { id: 'v0', op: 'vec_get_element', vec: 'u_mat4', index: 0 },
      { id: 'v5', op: 'vec_get_element', vec: 'u_mat4', index: 5 },
      { id: 'store0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'v0' },
      { id: 'store1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'v5' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(1, 4);
      expect(res.data?.[1]).toBeCloseTo(6, 4);
    }
  );

  // 6. Int Scalar
  runInputTest(
    'should handle int scalar input',
    [{ id: 'u_int', type: 'int' }],
    { u_int: 42 },
    [
      { id: 'cast', op: 'static_cast_float', val: 'u_int' },
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'cast' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      const val = res.data?.[0]; // float buffer
      expect(val).toBeCloseTo(42, 4);
    }
  );

  // 7. Bool Scalar
  runInputTest(
    'should handle bool scalar input',
    [{ id: 'u_bool', type: 'bool' }],
    { u_bool: true },
    [
      { id: 'cast', op: 'static_cast_float', val: 'u_bool' }, // Should be 1.0
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'cast' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(1.0, 4);
    }
  );

});
