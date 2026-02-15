import { describe, it, expect } from 'vitest';
import { runFullGraphTest, runParametricTest, buildSimpleIR, cpuBackends, availableBackends } from './test-runner';
import { validateIR } from '../../ir/validator';
import { IRDocument } from '../../ir/types';

// Atomic counters: CPU backends test correctness, GPU backends test actual atomics.
const backends = cpuBackends;

describe('Conformance: Atomic Counters', () => {
  if (backends.length === 0) {
    it.skip('Skipping atomic counter tests for current backend', () => { });
  } else {

    // ----------------------------------------------------------------
    // Basic atomic_store / atomic_load
    // ----------------------------------------------------------------
    describe('Store and Load', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Atomic Store/Load' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'cnt',
            type: 'atomic_counter',
            dataType: 'int',
            size: { mode: 'fixed', value: 4 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
          },
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'int',
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
            localVars: [],
            nodes: [
              // Store values into atomic counter
              { id: 's0', op: 'atomic_store', counter: 'cnt', index: 0, value: 10 },
              { id: 's1', op: 'atomic_store', counter: 'cnt', index: 1, value: 20 },
              { id: 's2', op: 'atomic_store', counter: 'cnt', index: 2, value: 30 },
              { id: 's3', op: 'atomic_store', counter: 'cnt', index: 3, value: 40 },
              // Load values back and store in result buffer
              { id: 'l0', op: 'atomic_load', counter: 'cnt', index: 0 },
              { id: 'l1', op: 'atomic_load', counter: 'cnt', index: 1 },
              { id: 'l2', op: 'atomic_load', counter: 'cnt', index: 2 },
              { id: 'l3', op: 'atomic_load', counter: 'cnt', index: 3 },
              { id: 'r0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'l0' },
              { id: 'r1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'l1' },
              { id: 'r2', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'l2' },
              { id: 'r3', op: 'buffer_store', buffer: 'b_res', index: 3, value: 'l3' },
            ]
          }
        ]
      };

      runFullGraphTest('should store and load atomic counter values', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data?.[0]).toBe(10);
        expect(res.data?.[1]).toBe(20);
        expect(res.data?.[2]).toBe(30);
        expect(res.data?.[3]).toBe(40);
      }, backends);
    });

    // ----------------------------------------------------------------
    // atomic_add — CPU sequential
    // ----------------------------------------------------------------
    describe('Atomic Add (CPU)', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Atomic Add' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'cnt',
            type: 'atomic_counter',
            dataType: 'int',
            size: { mode: 'fixed', value: 2 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
          },
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'int',
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
            localVars: [],
            nodes: [
              // Initialize counter[0] = 5
              { id: 's0', op: 'atomic_store', counter: 'cnt', index: 0, value: 5 },
              // Add 3, should return old value (5)
              { id: 'a1', op: 'atomic_add', counter: 'cnt', index: 0, value: 3 },
              // Add 7, should return old value (8)
              { id: 'a2', op: 'atomic_add', counter: 'cnt', index: 0, value: 7 },
              // Load final value (15)
              { id: 'l0', op: 'atomic_load', counter: 'cnt', index: 0 },
              // Store results
              { id: 'r0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'a1' },
              { id: 'r1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'a2' },
              { id: 'r2', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'l0' },
            ]
          }
        ]
      };

      runFullGraphTest('should add and return old value', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data?.[0]).toBe(5);   // old value before first add
        expect(res.data?.[1]).toBe(8);   // old value before second add (5+3)
        expect(res.data?.[2]).toBe(15);  // final value (5+3+7)
      }, backends);
    });

    // ----------------------------------------------------------------
    // atomic_sub
    // ----------------------------------------------------------------
    describe('Atomic Sub', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Atomic Sub' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'cnt',
            type: 'atomic_counter',
            dataType: 'int',
            size: { mode: 'fixed', value: 1 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
          },
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'int',
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
            localVars: [],
            nodes: [
              { id: 's0', op: 'atomic_store', counter: 'cnt', index: 0, value: 100 },
              { id: 'a1', op: 'atomic_sub', counter: 'cnt', index: 0, value: 30 },
              { id: 'l0', op: 'atomic_load', counter: 'cnt', index: 0 },
              { id: 'r0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'a1' },
              { id: 'r1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'l0' },
            ]
          }
        ]
      };

      runFullGraphTest('should subtract and return old value', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data?.[0]).toBe(100);  // old value
        expect(res.data?.[1]).toBe(70);   // 100 - 30
      }, backends);
    });

    // ----------------------------------------------------------------
    // atomic_min / atomic_max
    // ----------------------------------------------------------------
    describe('Atomic Min/Max', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Atomic Min/Max' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'cnt',
            type: 'atomic_counter',
            dataType: 'int',
            size: { mode: 'fixed', value: 2 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
          },
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'int',
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
            localVars: [],
            nodes: [
              // counter[0] = 50, counter[1] = 50
              { id: 's0', op: 'atomic_store', counter: 'cnt', index: 0, value: 50 },
              { id: 's1', op: 'atomic_store', counter: 'cnt', index: 1, value: 50 },
              // min(50, 30) -> old=50, new=30
              { id: 'mn', op: 'atomic_min', counter: 'cnt', index: 0, value: 30 },
              // max(50, 80) -> old=50, new=80
              { id: 'mx', op: 'atomic_max', counter: 'cnt', index: 1, value: 80 },
              // Load final values
              { id: 'l0', op: 'atomic_load', counter: 'cnt', index: 0 },
              { id: 'l1', op: 'atomic_load', counter: 'cnt', index: 1 },
              // Store results
              { id: 'r0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'mn' },
              { id: 'r1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'l0' },
              { id: 'r2', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'mx' },
              { id: 'r3', op: 'buffer_store', buffer: 'b_res', index: 3, value: 'l1' },
            ]
          }
        ]
      };

      runFullGraphTest('should compute min/max and return old value', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data?.[0]).toBe(50);  // old before min
        expect(res.data?.[1]).toBe(30);  // final after min(50,30)
        expect(res.data?.[2]).toBe(50);  // old before max
        expect(res.data?.[3]).toBe(80);  // final after max(50,80)
      }, backends);
    });

    // ----------------------------------------------------------------
    // atomic_exchange
    // ----------------------------------------------------------------
    describe('Atomic Exchange', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Atomic Exchange' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'cnt',
            type: 'atomic_counter',
            dataType: 'int',
            size: { mode: 'fixed', value: 1 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
          },
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'int',
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
            localVars: [],
            nodes: [
              { id: 's0', op: 'atomic_store', counter: 'cnt', index: 0, value: 42 },
              // Exchange: set to 99, get old (42)
              { id: 'x1', op: 'atomic_exchange', counter: 'cnt', index: 0, value: 99 },
              // Exchange again: set to 7, get old (99)
              { id: 'x2', op: 'atomic_exchange', counter: 'cnt', index: 0, value: 7 },
              { id: 'l0', op: 'atomic_load', counter: 'cnt', index: 0 },
              { id: 'r0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'x1' },
              { id: 'r1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'x2' },
              { id: 'r2', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'l0' },
            ]
          }
        ]
      };

      runFullGraphTest('should exchange and return old value', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data?.[0]).toBe(42);  // old before first exchange
        expect(res.data?.[1]).toBe(99);  // old before second exchange
        expect(res.data?.[2]).toBe(7);   // final value
      }, backends);
    });

    // ----------------------------------------------------------------
    // GPU atomic_add (64 threads each add 1)
    // Uses a two-pass approach: first shader atomically adds, second shader reads result
    // dispatch = thread counts (all backends agree on this semantic)
    // ----------------------------------------------------------------
    describe('GPU Atomic Add', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'GPU Atomic Add' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'cnt',
            type: 'atomic_counter',
            dataType: 'int',
            size: { mode: 'fixed', value: 1 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
          },
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 1 },
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
            localVars: [],
            nodes: [
              // Dispatch 64 threads, each adds 1
              { id: 'd', op: 'cmd_dispatch', func: 'shader_add', dispatch: [64, 1, 1] },
              // Dispatch 1 thread to read counter into result buffer
              { id: 'd2', op: 'cmd_dispatch', func: 'shader_read', dispatch: [1, 1, 1] },
            ]
          },
          {
            id: 'shader_add',
            type: 'shader',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'a', op: 'atomic_add', counter: 'cnt', index: 0, value: 1 },
            ]
          },
          {
            id: 'shader_read',
            type: 'shader',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'l', op: 'atomic_load', counter: 'cnt', index: 0 },
              { id: 'lf', op: 'static_cast_float', val: 'l' },
              { id: 'r', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'lf' },
            ]
          }
        ]
      };

      runFullGraphTest('64 threads each add 1', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        // 64 threads, each adding 1 = 64
        expect(res.data?.[0]).toBe(64);
      }, backends);
    });

    // ----------------------------------------------------------------
    // resource_get_size on atomic_counter
    // ----------------------------------------------------------------
    describe('Resource Get Size', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Atomic Counter Size' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'cnt',
            type: 'atomic_counter',
            dataType: 'int',
            size: { mode: 'fixed', value: 8 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
          },
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 1 },
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
            localVars: [],
            nodes: [
              { id: 'sz', op: 'resource_get_size', resource: 'cnt' },
              { id: 'szx', op: 'vec_get_element', vec: 'sz', index: 0 },
              { id: 'r0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'szx' },
            ]
          }
        ]
      };

      runFullGraphTest('should return atomic counter size', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data?.[0]).toBe(8);
      }, backends);
    });

    // ----------------------------------------------------------------
    // Validation: atomic ops must reference atomic_counter resources
    // ----------------------------------------------------------------
    describe('Validation', () => {
      it('should reject atomic ops on regular buffers', () => {
        const ir = buildSimpleIR('Atomic on Buffer', [
          { id: 'a', op: 'atomic_add', counter: 'buf', index: 0, value: 1 },
        ], [
          { id: 'buf', type: 'buffer', dataType: 'int', size: { mode: 'fixed', value: 1 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }
        ]);

        const errors = validateIR(ir);
        expect(errors.some(e => e.message.includes('atomic_counter'))).toBe(true);
      });

      it('should reject atomic_counter with non-int dataType', () => {
        const ir: IRDocument = {
          version: '1.0.0',
          meta: { name: 'Bad Atomic Counter' },
          entryPoint: 'main',
          inputs: [],
          resources: [
            {
              id: 'cnt',
              type: 'atomic_counter',
              dataType: 'float',
              size: { mode: 'fixed', value: 1 },
              persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
            }
          ],
          structs: [],
          functions: [{
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: []
          }]
        };

        const errors = validateIR(ir);
        expect(errors.some(e => e.message.includes("dataType 'int'"))).toBe(true);
      });
    });
  }
});
