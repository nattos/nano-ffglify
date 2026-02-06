
import { describe, it, expect } from 'vitest';
import { cpuBackends, runFullGraphTest } from './test-runner';
import { IRDocument } from '../../ir/types';

// Marshalling is critical for backends that can dispatch compute jobs.
const backends = cpuBackends;

describe('Conformance: GPU Stress Tests', () => {
  if (backends.length === 0) {
    it.skip('Skipping GPU Stress tests (no compatible backend)', () => { });
    return;
  }

  // ----------------------------------------------------------------
  // Buffer Aliasing (Read-Modify-Write)
  // ----------------------------------------------------------------
  const irAliasing: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Buffer Aliasing' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_rw',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 1 },
        persistence: { retain: true, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
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
          // Init buffer to 10
          { id: 'init', op: 'buffer_store', buffer: 'b_rw', index: 0, value: 10, next: 'disp' },

          // Dispatch Shader that increments
          { id: 'disp', op: 'cmd_dispatch', func: 'shader_inc', dispatch: [1, 1, 1] },
        ],
      },
      {
        id: 'shader_inc',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'v', op: 'buffer_load', buffer: 'b_rw', index: 0 },
          { id: 'v_inc', op: 'math_add', a: 'v', b: 5.0 },
          { id: 'store', op: 'buffer_store', buffer: 'b_rw', index: 0, value: 'v_inc' }
        ]
      }
    ]
  };

  runFullGraphTest('Buffer Aliasing', irAliasing, (ctx) => {
    const res = ctx.getResource('b_rw');
    expect(res.data).toBeDefined();
    // 10 + 5 = 15
    expect(res.data![0]).toBe(15);
  }, backends);


  // ----------------------------------------------------------------
  // Large Dispatch
  // ----------------------------------------------------------------
  const size = 256;
  const irLarge: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Large Dispatch' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_out',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: size },
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
          { id: 'disp', op: 'cmd_dispatch', func: 'shader_fill', dispatch: [size, 1, 1] }
        ],
      },
      {
        id: 'shader_fill',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'idx', op: 'vec_swizzle', vec: 'gid', channels: 'x' },
          { id: 'fidx', op: 'static_cast_float', val: 'idx' }, // if we want to store float
          { id: 'store', op: 'buffer_store', buffer: 'b_out', index: 'idx', value: 'fidx' }
        ]
      }
    ]
  };

  runFullGraphTest('Large Dispatch', irLarge, (ctx) => {
    const res = ctx.getResource('b_out');
    // Verify [0, 1, ... 255]
    for (let i = 0; i < size; i++) {
      expect(res.data![i]).toBe(i);
    }
  }, backends);

});
