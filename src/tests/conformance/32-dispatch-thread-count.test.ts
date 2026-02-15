import { describe, it, expect } from 'vitest';
import { runFullGraphTest, cpuBackends } from './test-runner';
import { IRDocument } from '../../ir/types';

// These tests verify that `dispatch` means thread counts, not workgroup counts.
// Each thread writes a marker value to its gid position in a result buffer.
const backends = cpuBackends;

describe('Conformance: Dispatch Thread Count Semantics', () => {
  if (backends.length === 0) {
    it.skip('Skipping dispatch thread count tests for current backend', () => { });
  } else {

    // ----------------------------------------------------------------
    // Test 1: Dispatch [4,1,1] — exactly 4 threads
    // ----------------------------------------------------------------
    describe('1D dispatch [4,1,1]', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Dispatch 4 Threads' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 8 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
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
              { id: 'd', op: 'cmd_dispatch', func: 'shader_write', threads: [4, 1, 1] },
            ]
          },
          {
            id: 'shader_write',
            type: 'shader',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
              { id: 'idx', op: 'vec_get_element', vec: 'gid', index: 0 },
              { id: 'val', op: 'literal', val: 1.0 },
              { id: 'w', op: 'buffer_store', buffer: 'b_res', index: 'idx', value: 'val' },
            ]
          }
        ]
      };

      runFullGraphTest('exactly 4 threads write to buffer', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        // Threads 0-3 should write 1.0, threads 4-7 should remain 0.0
        for (let i = 0; i < 4; i++) {
          expect(res.data?.[i]).toBe(1.0);
        }
        for (let i = 4; i < 8; i++) {
          expect(res.data?.[i]).toBe(0.0);
        }
      }, backends);
    });

    // ----------------------------------------------------------------
    // Test 2: Dispatch [17,1,1] — non-power-of-2, non-workgroup-aligned
    // ----------------------------------------------------------------
    describe('1D dispatch [17,1,1] (non-aligned)', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Dispatch 17 Threads' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 32 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
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
              { id: 'd', op: 'cmd_dispatch', func: 'shader_write', threads: [17, 1, 1] },
            ]
          },
          {
            id: 'shader_write',
            type: 'shader',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
              { id: 'idx', op: 'vec_get_element', vec: 'gid', index: 0 },
              { id: 'val', op: 'literal', val: 1.0 },
              { id: 'w', op: 'buffer_store', buffer: 'b_res', index: 'idx', value: 'val' },
            ]
          }
        ]
      };

      runFullGraphTest('exactly 17 threads write to buffer (not rounded up)', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        // Threads 0-16 should write 1.0
        for (let i = 0; i < 17; i++) {
          expect(res.data?.[i]).toBe(1.0);
        }
        // Threads 17-31 should remain 0.0 (not rounded up to 32)
        for (let i = 17; i < 32; i++) {
          expect(res.data?.[i]).toBe(0.0);
        }
      }, backends);
    });

    // ----------------------------------------------------------------
    // Test 3: Dispatch [2,3,1] — 2D dispatch, 6 threads total
    // ----------------------------------------------------------------
    describe('2D dispatch [2,3,1]', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Dispatch 2x3 Threads' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 8 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
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
              { id: 'd', op: 'cmd_dispatch', func: 'shader_write', threads: [2, 3, 1] },
            ]
          },
          {
            id: 'shader_write',
            type: 'shader',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
              { id: 'gx', op: 'vec_get_element', vec: 'gid', index: 0 },
              { id: 'gy', op: 'vec_get_element', vec: 'gid', index: 1 },
              // index = gy * 2 + gx
              { id: 'gy_times_2', op: 'math_mul', a: 'gy', b: 2 },
              { id: 'idx', op: 'math_add', a: 'gy_times_2', b: 'gx' },
              { id: 'val', op: 'literal', val: 1.0 },
              { id: 'w', op: 'buffer_store', buffer: 'b_res', index: 'idx', value: 'val' },
            ]
          }
        ]
      };

      runFullGraphTest('2x3 dispatch writes exactly 6 entries', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        // 6 threads write 1.0 to indices 0-5
        for (let i = 0; i < 6; i++) {
          expect(res.data?.[i]).toBe(1.0);
        }
        // Indices 6-7 should remain 0.0
        for (let i = 6; i < 8; i++) {
          expect(res.data?.[i]).toBe(0.0);
        }
      }, backends);
    });

    // ----------------------------------------------------------------
    // Test 4: Custom workgroupSize on FunctionDef
    // ----------------------------------------------------------------
    describe('Custom workgroupSize', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Custom Workgroup Size' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 16 },
            persistence: { retain: false, clearEveryFrame: true, clearOnResize: false, cpuAccess: true }
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
              { id: 'd', op: 'cmd_dispatch', func: 'shader_write', threads: [10, 1, 1] },
            ]
          },
          {
            id: 'shader_write',
            type: 'shader',
            inputs: [],
            outputs: [],
            localVars: [],
            workgroupSize: [8, 1, 1],
            nodes: [
              { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
              { id: 'idx', op: 'vec_get_element', vec: 'gid', index: 0 },
              { id: 'val', op: 'literal', val: 1.0 },
              { id: 'w', op: 'buffer_store', buffer: 'b_res', index: 'idx', value: 'val' },
            ]
          }
        ]
      };

      runFullGraphTest('custom workgroupSize [8,1,1] with 10 threads', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        // 10 threads should write 1.0 to indices 0-9
        for (let i = 0; i < 10; i++) {
          expect(res.data?.[i]).toBe(1.0);
        }
        // Indices 10-15 should remain 0.0
        for (let i = 10; i < 16; i++) {
          expect(res.data?.[i]).toBe(0.0);
        }
      }, backends);
    });
  }
});
