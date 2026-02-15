import { describe, it, expect } from 'vitest';
import { cpuBackends, runFullGraphTest } from './test-runner';
import { IRDocument } from '../../ir/types';

// Resource resize tests require CPU+GPU dispatch (CppMetal backend).
const backends = cpuBackends;

describe('Conformance: Resource Resize', () => {
  if (backends.length === 0) {
    it.skip('Skipping Resource Resize tests (no compatible backend)', () => { });
    return;
  }

  // ----------------------------------------------------------------
  // Test 1: Buffer resize + GPU write (Issue #3)
  // Resize buffer from 2 to 10, dispatch shader that writes index values
  // ----------------------------------------------------------------
  const irResizeGpuWrite: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Buffer Resize GPU Write' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_output',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 2 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: true, cpuAccess: true }
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
          { id: 'resize', op: 'cmd_resize_resource', resource: 'b_output', size: 10, next: 'disp' },
          { id: 'disp', op: 'cmd_dispatch', func: 'shader_fill', threads: [10, 1, 1] }
        ]
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
          { id: 'fidx', op: 'static_cast_float', val: 'idx' },
          { id: 'store', op: 'buffer_store', buffer: 'b_output', index: 'idx', value: 'fidx' }
        ]
      }
    ]
  };

  runFullGraphTest('Buffer resize then GPU write', irResizeGpuWrite, (ctx) => {
    const res = ctx.getResource('b_output');
    expect(res.width).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(res.data![i]).toBe(i);
    }
  }, backends);

  // ----------------------------------------------------------------
  // Test 2: Buffer resize + resource_get_size on CPU (Issue #2 CPU)
  // Resize buffer then query its size on CPU
  // ----------------------------------------------------------------
  const irResizeCpuGetSize: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Buffer Resize CPU Get Size' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_data',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 5 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: true, cpuAccess: true }
      },
      {
        id: 'b_output',
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
          { id: 'resize', op: 'cmd_resize_resource', resource: 'b_data', size: 20, next: 'store' },
          { id: 'get_size', op: 'resource_get_size', resource: 'b_data' },
          { id: 'size_x', op: 'vec_get_element', vec: 'get_size', index: 0 },
          { id: 'store', op: 'buffer_store', buffer: 'b_output', index: 0, value: 'size_x' }
        ]
      }
    ]
  };

  runFullGraphTest('Buffer resize then CPU resource_get_size', irResizeCpuGetSize, (ctx) => {
    const res = ctx.getResource('b_output');
    expect(res.data![0]).toBe(20);
  }, backends);

  // ----------------------------------------------------------------
  // Test 3: Buffer resize + resource_get_size in shader (Issue #2 GPU)
  // Resize buffer on CPU, then shader queries its size
  // ----------------------------------------------------------------
  const irResizeShaderGetSize: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Buffer Resize Shader Get Size' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_data',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 5 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: true, cpuAccess: true }
      },
      {
        id: 'b_output',
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
          { id: 'resize', op: 'cmd_resize_resource', resource: 'b_data', size: 20, next: 'disp' },
          { id: 'disp', op: 'cmd_dispatch', func: 'shader_check_size', threads: [1, 1, 1] }
        ]
      },
      {
        id: 'shader_check_size',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'size_vec', op: 'resource_get_size', resource: 'b_data' },
          { id: 'size_x', op: 'vec_get_element', vec: 'size_vec', index: 0 },
          { id: 'store', op: 'buffer_store', buffer: 'b_output', index: 0, value: 'size_x' }
        ]
      }
    ]
  };

  runFullGraphTest('Buffer resize then shader resource_get_size', irResizeShaderGetSize, (ctx) => {
    const res = ctx.getResource('b_output');
    expect(res.data![0]).toBe(20);
  }, backends);

  // ----------------------------------------------------------------
  // Test 4: Multiple resize + dispatch cycles (Issue #3 re-sync)
  // Resize to 5 → dispatch (write 42) → resize to 10 → dispatch (write 99)
  // ----------------------------------------------------------------
  const irMultiResize: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Multiple Resize Cycles' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_buf',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 1 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: true, cpuAccess: true }
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
          // Cycle 1: resize to 5, dispatch shader that writes 42
          { id: 'resize1', op: 'cmd_resize_resource', resource: 'b_buf', size: 5, next: 'disp1' },
          { id: 'disp1', op: 'cmd_dispatch', func: 'shader_write_42', threads: [5, 1, 1], next: 'resize2' },
          // Cycle 2: resize to 10 (clears data), dispatch shader that writes 99
          { id: 'resize2', op: 'cmd_resize_resource', resource: 'b_buf', size: 10, next: 'disp2' },
          { id: 'disp2', op: 'cmd_dispatch', func: 'shader_write_99', threads: [10, 1, 1] }
        ]
      },
      {
        id: 'shader_write_42',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'idx', op: 'vec_swizzle', vec: 'gid', channels: 'x' },
          { id: 'store', op: 'buffer_store', buffer: 'b_buf', index: 'idx', value: 42 }
        ]
      },
      {
        id: 'shader_write_99',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'idx', op: 'vec_swizzle', vec: 'gid', channels: 'x' },
          { id: 'store', op: 'buffer_store', buffer: 'b_buf', index: 'idx', value: 99 }
        ]
      }
    ]
  };

  runFullGraphTest('Multiple resize + dispatch cycles', irMultiResize, (ctx) => {
    const res = ctx.getResource('b_buf');
    expect(res.width).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(res.data![i]).toBe(99);
    }
  }, backends);

  // ----------------------------------------------------------------
  // Test 5: GPU data survives non-clearing resize (GPU-to-GPU copy)
  // Dispatch writes values to b_data, resize without clearing,
  // then dispatch reads b_data back into b_output to verify survival
  // ----------------------------------------------------------------
  const irGpuDataSurvivesResize: IRDocument = {
    version: '1.0.0',
    meta: { name: 'GPU Data Survives Resize' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_data',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 5 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
      },
      {
        id: 'b_output',
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
        localVars: [],
        nodes: [
          // Step 1: dispatch shader that writes (gid.x + 1) * 10 into b_data[gid.x]
          { id: 'disp1', op: 'cmd_dispatch', func: 'shader_write', threads: [5, 1, 1], next: 'resize' },
          // Step 2: resize b_data from 5 to 10 (clearOnResize = false)
          { id: 'resize', op: 'cmd_resize_resource', resource: 'b_data', size: 10, next: 'disp2' },
          // Step 3: dispatch shader that reads b_data[gid.x] into b_output[gid.x]
          { id: 'disp2', op: 'cmd_dispatch', func: 'shader_read', threads: [5, 1, 1] }
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
          { id: 'idx', op: 'vec_swizzle', vec: 'gid', channels: 'x' },
          { id: 'fidx', op: 'static_cast_float', val: 'idx' },
          { id: 'idx_plus_1', op: 'math_add', a: 'fidx', b: 1 },
          { id: 'val', op: 'math_mul', a: 'idx_plus_1', b: 10 },
          { id: 'store', op: 'buffer_store', buffer: 'b_data', index: 'idx', value: 'val' }
        ]
      },
      {
        id: 'shader_read',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'idx', op: 'vec_swizzle', vec: 'gid', channels: 'x' },
          { id: 'load', op: 'buffer_load', buffer: 'b_data', index: 'idx' },
          { id: 'store', op: 'buffer_store', buffer: 'b_output', index: 'idx', value: 'load' }
        ]
      }
    ]
  };

  runFullGraphTest('GPU data survives non-clearing resize', irGpuDataSurvivesResize, (ctx) => {
    const res = ctx.getResource('b_output');
    // Original 5 elements should be preserved: [10, 20, 30, 40, 50]
    expect(res.data![0]).toBe(10);
    expect(res.data![1]).toBe(20);
    expect(res.data![2]).toBe(30);
    expect(res.data![3]).toBe(40);
    expect(res.data![4]).toBe(50);
  }, backends);

});
