import { describe, it, expect } from 'vitest';
import { runFullGraphTest, cpuBackends } from './test-runner';
import { IRDocument } from '../../ir/types';

const backends = cpuBackends;

describe('Conformance: PRNG', () => {
  if (backends.length === 0) {
    it.skip('Skipping PRNG tests for current backend', () => { });
  } else {

    // ----------------------------------------------------------------
    // Deterministic seed: prng_make(42) → prng_next × 3 → all different, all deterministic
    // ----------------------------------------------------------------
    describe('Deterministic seed', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'PRNG Deterministic' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 4 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [{ id: 'rng', type: 'prng' }],
            nodes: [
              { id: 'mk', op: 'prng_make', seed: 42 },
              { id: 'set', op: 'var_set', var: 'rng', val: 'mk', exec_out: 'n1' },
              { id: 'n1', op: 'prng_next', prng: 'rng', exec_out: 'n2' },
              { id: 'n2', op: 'prng_next', prng: 'rng', exec_out: 'n3' },
              { id: 'n3', op: 'prng_next', prng: 'rng', exec_out: 'w0' },
              { id: 'w0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'n1', exec_out: 'w1' },
              { id: 'w1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'n2', exec_out: 'w2' },
              { id: 'w2', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'n3' },
            ]
          }
        ]
      };

      runFullGraphTest('should produce deterministic values with explicit seed', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        const v0 = res.data?.[0] ?? -1;
        const v1 = res.data?.[1] ?? -1;
        const v2 = res.data?.[2] ?? -1;
        // All values should be different from each other
        expect(v0).not.toBe(v1);
        expect(v1).not.toBe(v2);
        expect(v0).not.toBe(v2);
      }, backends);

      runFullGraphTest('should produce same values on repeated execution', ir, async (ctx) => {
        const res = ctx.getResource('b_res');
        const first = [res.data?.[0], res.data?.[1], res.data?.[2]];
        // Values should be deterministic (non-zero)
        expect(first[0]).not.toBe(0);
        expect(first[1]).not.toBe(0);
        expect(first[2]).not.toBe(0);
      }, backends);
    });

    // ----------------------------------------------------------------
    // Float range: All prng_next float results in [0, 1]
    // ----------------------------------------------------------------
    describe('Float range', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'PRNG Float Range' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 10 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [{ id: 'rng', type: 'prng' }],
            nodes: [
              { id: 'mk', op: 'prng_make', seed: 123 },
              { id: 'set', op: 'var_set', var: 'rng', val: 'mk', exec_out: 'n0' },
              { id: 'n0', op: 'prng_next', prng: 'rng', exec_out: 'n1' },
              { id: 'n1', op: 'prng_next', prng: 'rng', exec_out: 'n2' },
              { id: 'n2', op: 'prng_next', prng: 'rng', exec_out: 'n3' },
              { id: 'n3', op: 'prng_next', prng: 'rng', exec_out: 'n4' },
              { id: 'n4', op: 'prng_next', prng: 'rng', exec_out: 'n5' },
              { id: 'n5', op: 'prng_next', prng: 'rng', exec_out: 'n6' },
              { id: 'n6', op: 'prng_next', prng: 'rng', exec_out: 'n7' },
              { id: 'n7', op: 'prng_next', prng: 'rng', exec_out: 'n8' },
              { id: 'n8', op: 'prng_next', prng: 'rng', exec_out: 'n9' },
              { id: 'n9', op: 'prng_next', prng: 'rng', exec_out: 'w0' },
              { id: 'w0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'n0', exec_out: 'w1' },
              { id: 'w1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'n1', exec_out: 'w2' },
              { id: 'w2', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'n2', exec_out: 'w3' },
              { id: 'w3', op: 'buffer_store', buffer: 'b_res', index: 3, value: 'n3', exec_out: 'w4' },
              { id: 'w4', op: 'buffer_store', buffer: 'b_res', index: 4, value: 'n4', exec_out: 'w5' },
              { id: 'w5', op: 'buffer_store', buffer: 'b_res', index: 5, value: 'n5', exec_out: 'w6' },
              { id: 'w6', op: 'buffer_store', buffer: 'b_res', index: 6, value: 'n6', exec_out: 'w7' },
              { id: 'w7', op: 'buffer_store', buffer: 'b_res', index: 7, value: 'n7', exec_out: 'w8' },
              { id: 'w8', op: 'buffer_store', buffer: 'b_res', index: 8, value: 'n8', exec_out: 'w9' },
              { id: 'w9', op: 'buffer_store', buffer: 'b_res', index: 9, value: 'n9' },
            ]
          }
        ]
      };

      runFullGraphTest('should produce float values in [0, 1]', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        for (let i = 0; i < 10; i++) {
          const v = res.data?.[i] ?? -1;
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }, backends);
    });

    // ----------------------------------------------------------------
    // Int output with min/max
    // ----------------------------------------------------------------
    describe('Int output with min/max', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'PRNG Int MinMax' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 5 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [{ id: 'rng', type: 'prng' }],
            nodes: [
              { id: 'mk', op: 'prng_make', seed: 77 },
              { id: 'set', op: 'var_set', var: 'rng', val: 'mk', exec_out: 'n0' },
              { id: 'n0', op: 'prng_next', prng: 'rng', type: 'int', min: 10, max: 20, exec_out: 'n1' },
              { id: 'n1', op: 'prng_next', prng: 'rng', type: 'int', min: 10, max: 20, exec_out: 'n2' },
              { id: 'n2', op: 'prng_next', prng: 'rng', type: 'int', min: 10, max: 20, exec_out: 'n3' },
              { id: 'n3', op: 'prng_next', prng: 'rng', type: 'int', min: 10, max: 20, exec_out: 'n4' },
              { id: 'n4', op: 'prng_next', prng: 'rng', type: 'int', min: 10, max: 20, exec_out: 'w0' },
              { id: 'c0', op: 'static_cast_float', val: 'n0' },
              { id: 'c1', op: 'static_cast_float', val: 'n1' },
              { id: 'c2', op: 'static_cast_float', val: 'n2' },
              { id: 'c3', op: 'static_cast_float', val: 'n3' },
              { id: 'c4', op: 'static_cast_float', val: 'n4' },
              { id: 'w0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'c0', exec_out: 'w1' },
              { id: 'w1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'c1', exec_out: 'w2' },
              { id: 'w2', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'c2', exec_out: 'w3' },
              { id: 'w3', op: 'buffer_store', buffer: 'b_res', index: 3, value: 'c3', exec_out: 'w4' },
              { id: 'w4', op: 'buffer_store', buffer: 'b_res', index: 4, value: 'c4' },
            ]
          }
        ]
      };

      runFullGraphTest('should produce int values in [min, max] range', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        for (let i = 0; i < 5; i++) {
          const v = res.data?.[i] ?? -1;
          expect(v).toBeGreaterThanOrEqual(10);
          expect(v).toBeLessThanOrEqual(20);
          // Should be integer
          expect(v % 1).toBe(0);
        }
      }, backends);
    });

    // ----------------------------------------------------------------
    // Vector output: float3
    // ----------------------------------------------------------------
    describe('Vector output', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'PRNG Vector' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 3 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [{ id: 'rng', type: 'prng' }],
            nodes: [
              { id: 'mk', op: 'prng_make', seed: 99 },
              { id: 'set', op: 'var_set', var: 'rng', val: 'mk', exec_out: 'n0' },
              { id: 'n0', op: 'prng_next', prng: 'rng', type: 'float3', exec_out: 'w0' },
              { id: 'gx', op: 'vec_get_element', vec: 'n0', index: 0 },
              { id: 'gy', op: 'vec_get_element', vec: 'n0', index: 1 },
              { id: 'gz', op: 'vec_get_element', vec: 'n0', index: 2 },
              { id: 'w0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'gx', exec_out: 'w1' },
              { id: 'w1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'gy', exec_out: 'w2' },
              { id: 'w2', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'gz' },
            ]
          }
        ]
      };

      runFullGraphTest('should produce 3-component float3 result', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        for (let i = 0; i < 3; i++) {
          const v = res.data?.[i] ?? -1;
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        // Components should be different
        expect(res.data?.[0]).not.toBe(res.data?.[1]);
        expect(res.data?.[1]).not.toBe(res.data?.[2]);
      }, backends);
    });

    // ----------------------------------------------------------------
    // Int output (no min/max)
    // ----------------------------------------------------------------
    describe('Int output', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'PRNG Int' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 2 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [{ id: 'rng', type: 'prng' }],
            nodes: [
              { id: 'mk', op: 'prng_make', seed: 55 },
              { id: 'set', op: 'var_set', var: 'rng', val: 'mk', exec_out: 'n0' },
              { id: 'n0', op: 'prng_next', prng: 'rng', type: 'int', exec_out: 'n1' },
              { id: 'n1', op: 'prng_next', prng: 'rng', type: 'int', exec_out: 'w0' },
              { id: 'c0', op: 'static_cast_float', val: 'n0' },
              { id: 'c1', op: 'static_cast_float', val: 'n1' },
              { id: 'w0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'c0', exec_out: 'w1' },
              { id: 'w1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'c1' },
            ]
          }
        ]
      };

      runFullGraphTest('should produce integer values', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        const v0 = res.data?.[0] ?? 0;
        const v1 = res.data?.[1] ?? 0;
        // Should be integer (stored as float in buffer)
        expect(v0 % 1).toBe(0);
        expect(v1 % 1).toBe(0);
        // Should be non-zero and different
        expect(v0).not.toBe(0);
        expect(v0).not.toBe(v1);
      }, backends);
    });

    // ----------------------------------------------------------------
    // Auto-seed (no explicit seed): non-zero state
    // ----------------------------------------------------------------
    describe('Auto-seed', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'PRNG Auto-seed' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 2 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [{ id: 'rng', type: 'prng' }],
            nodes: [
              { id: 'mk', op: 'prng_make' },
              { id: 'set', op: 'var_set', var: 'rng', val: 'mk', exec_out: 'n0' },
              { id: 'n0', op: 'prng_next', prng: 'rng', exec_out: 'n1' },
              { id: 'n1', op: 'prng_next', prng: 'rng', exec_out: 'w0' },
              { id: 'w0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'n0', exec_out: 'w1' },
              { id: 'w1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'n1' },
            ]
          }
        ]
      };

      const builtins = new Map<string, any>([['prng_seed', 0.5]]);

      runFullGraphTest('should produce non-zero values with auto-seed', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        const v0 = res.data?.[0] ?? 0;
        const v1 = res.data?.[1] ?? 0;
        // Values should be in [0, 1] and non-zero
        expect(v0).toBeGreaterThanOrEqual(0);
        expect(v0).toBeLessThanOrEqual(1);
        expect(v1).toBeGreaterThanOrEqual(0);
        expect(v1).toBeLessThanOrEqual(1);
        // At least one should be non-zero
        expect(v0 + v1).toBeGreaterThan(0);
      }, backends, undefined, builtins);
    });

  }
});
