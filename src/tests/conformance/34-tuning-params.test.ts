import { describe, expect, it } from 'vitest';
import { IRDocument } from '../../ir/types';
import { EvaluationContext } from '../../interpreter/context';
import { availableBackends, cpuBackends, runFullGraphTest } from './test-runner';

describe('Conformance: Tuning Parameters', () => {

  const bufferRes = {
    id: 'b_result',
    type: 'buffer',
    dataType: 'float',
    size: { mode: 'fixed', value: 16 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
  };

  /**
   * Helper to run a test with tuning params. Builds an IR with tuningParams
   * (not inputs), passes values via the inputsMap, and verifies results.
   */
  const runTuningTest = (
    name: string,
    tuningParamsDef: { id: string, type: string, default?: any, ui?: any }[],
    inputValues: Record<string, any>,
    nodes: any[],
    verify: (ctx: EvaluationContext) => void,
    localVars: any[] = [],
    extraInputs: { id: string, type: string }[] = []
  ) => {
    availableBackends.forEach(backend => {
      it(`${name} [${backend.name}]`, async () => {
        const ir: IRDocument = {
          version: '1.0.0',
          meta: { name, debug: true },
          entryPoint: 'main',
          inputs: extraInputs.length > 0
            ? extraInputs
            : [{ id: 'u_dummy', type: 'float' }],
          tuningParams: tuningParamsDef,
          resources: [bufferRes],
          functions: [{
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: localVars,
            nodes: nodes,
          }],
        };

        const inputsMap = new Map<string, any>(Object.entries(inputValues));
        if (!inputsMap.has('u_dummy') && extraInputs.length === 0) {
          inputsMap.set('u_dummy', 0.0);
        }

        const ctx = await backend.execute(ir, 'main', inputsMap);
        try {
          await verify(ctx);
        } finally {
          ctx.destroy();
        }
      });
    });
  };

  // 1. Float scalar tuning param
  runTuningTest(
    'should handle float scalar tuning param',
    [{ id: 't_gain', type: 'float', default: 0.75 }],
    { t_gain: 123.456 },
    [
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 't_gain' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(123.456, 4);
    }
  );

  // 2. Float2 tuning param
  runTuningTest(
    'should handle float2 tuning param',
    [{ id: 't_offset', type: 'float2', default: [0, 0] }],
    { t_offset: [1.5, 2.5] },
    [
      { id: 'x', op: 'vec_get_element', vec: 't_offset', index: 0 },
      { id: 'y', op: 'vec_get_element', vec: 't_offset', index: 1 },
      { id: 's0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'x' },
      { id: 's1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'y' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(1.5, 4);
      expect(res.data?.[1]).toBeCloseTo(2.5, 4);
    }
  );

  // 3. Float3 tuning param
  runTuningTest(
    'should handle float3 tuning param',
    [{ id: 't_color', type: 'float3', default: [0, 0, 0] }],
    { t_color: [10.1, 20.2, 30.3] },
    [
      { id: 'x', op: 'vec_get_element', vec: 't_color', index: 0 },
      { id: 'y', op: 'vec_get_element', vec: 't_color', index: 1 },
      { id: 'z', op: 'vec_get_element', vec: 't_color', index: 2 },
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

  // 4. Float4 tuning param
  runTuningTest(
    'should handle float4 tuning param',
    [{ id: 't_tint', type: 'float4', default: [0, 0, 0, 1] }],
    { t_tint: [0.1, 0.2, 0.3, 0.4] },
    [
      { id: 'x', op: 'vec_get_element', vec: 't_tint', index: 0 },
      { id: 'y', op: 'vec_get_element', vec: 't_tint', index: 1 },
      { id: 'z', op: 'vec_get_element', vec: 't_tint', index: 2 },
      { id: 'w', op: 'vec_get_element', vec: 't_tint', index: 3 },
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

  // 5. Int scalar tuning param
  runTuningTest(
    'should handle int scalar tuning param',
    [{ id: 't_iter', type: 'int', default: 10 }],
    { t_iter: 42 },
    [
      { id: 'cast', op: 'static_cast_float', val: 't_iter' },
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'cast' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(42, 4);
    }
  );

  // 6. Tuning param used in arithmetic
  runTuningTest(
    'should use tuning param in arithmetic',
    [{ id: 't_scale', type: 'float', default: 1.0 }],
    { t_scale: 2.5 },
    [
      { id: 'lit', op: 'literal', val: 3.0 },
      { id: 'mul', op: 'math_mul', a: 't_scale', b: 'lit' },
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'mul' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(7.5, 4);
    }
  );

  // 7. Mix of regular inputs and tuning params
  runTuningTest(
    'should handle both inputs and tuning params',
    [{ id: 't_bias', type: 'float', default: 0.0 }],
    { u_input: 5.0, t_bias: 3.0 },
    [
      { id: 'add', op: 'math_add', a: 'u_input', b: 't_bias' },
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'add' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(8.0, 4);
    },
    [],
    [{ id: 'u_input', type: 'float' }]
  );

  // 8. Multiple tuning params
  runTuningTest(
    'should handle multiple tuning params',
    [
      { id: 't_a', type: 'float', default: 1.0 },
      { id: 't_b', type: 'float', default: 2.0 },
    ],
    { t_a: 10.0, t_b: 20.0 },
    [
      { id: 'add', op: 'math_add', a: 't_a', b: 't_b' },
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'add' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(30.0, 4);
    }
  );

  // 9. Tuning param in a local variable store/load
  runTuningTest(
    'should store tuning param in local variable',
    [{ id: 't_val', type: 'float', default: 0.0 }],
    { t_val: 7.77 },
    [
      { id: 'set', op: 'var_set', var: 'tmp', val: 't_val' },
      { id: 'get', op: 'var_get', var: 'tmp' },
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'get' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(7.77, 4);
    },
    [{ id: 'tmp', type: 'float' }]
  );

  // 10. Tuning param with GPU dispatch (shader function reads tuning param)
  {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'tuning-param-gpu-dispatch', debug: true },
      entryPoint: 'main',
      inputs: [{ id: 'u_dummy', type: 'float' }],
      tuningParams: [{ id: 't_factor', type: 'float', default: 1.0 }],
      resources: [
        {
          id: 'b_result',
          type: 'buffer',
          dataType: 'float',
          size: { mode: 'fixed', value: 4 },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
        }
      ],
      functions: [
        {
          id: 'main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'dispatch', op: 'cmd_dispatch', func: 'compute_fn', threads: [4, 1, 1] }
          ],
        },
        {
          id: 'compute_fn',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'gid_vec', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'gid', op: 'vec_get_element', vec: 'gid_vec', index: 0 },
            { id: 'gid_f', op: 'static_cast_float', val: 'gid' },
            { id: 'mul', op: 'math_mul', a: 'gid_f', b: 't_factor' },
            { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 'gid', value: 'mul' }
          ],
        }
      ],
    };

    cpuBackends.forEach(backend => {
      it(`should dispatch tuning param to GPU shader [${backend.name}]`, async () => {
        const inputsMap = new Map<string, any>();
        inputsMap.set('u_dummy', 0.0);
        inputsMap.set('t_factor', 3.0);

        const ctx = await backend.execute(ir, 'main', inputsMap);
        try {
          const res = ctx.getResource('b_result');
          // Each thread writes gid * 3.0
          expect(res.data?.[0]).toBeCloseTo(0.0, 4);
          expect(res.data?.[1]).toBeCloseTo(3.0, 4);
          expect(res.data?.[2]).toBeCloseTo(6.0, 4);
          expect(res.data?.[3]).toBeCloseTo(9.0, 4);
        } finally {
          ctx.destroy();
        }
      });
    });
  }

  // 11. Tuning param with float4x4 (matrix)
  runTuningTest(
    'should handle float4x4 tuning param',
    [{ id: 't_mat', type: 'float4x4', default: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] }],
    { t_mat: [1,2,3,4, 5,6,7,8, 9,10,11,12, 13,14,15,16] },
    [
      { id: 'v0', op: 'vec_get_element', vec: 't_mat', index: 0 },
      { id: 'v5', op: 'vec_get_element', vec: 't_mat', index: 5 },
      { id: 'store0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'v0' },
      { id: 'store1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'v5' }
    ],
    (ctx) => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBeCloseTo(1, 4);
      expect(res.data?.[1]).toBeCloseTo(6, 4);
    }
  );

});
