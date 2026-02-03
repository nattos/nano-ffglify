import { describe, it, expect } from 'vitest';
import { availableBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { IRDocument, TextureFormat } from '../../ir/types';

// Marshalling is critical for backends that can dispatch compute jobs.
const backends = availableBackends.filter(b => b.name !== 'Compute' && b.name !== 'Puppeteer');

describe('Conformance: Integration - Precomputed Blur', () => {
  if (backends.length === 0) {
    it.skip('Skipping GPU Stress tests (no compatible backend)', () => { });
    return;
  }

  const ir: IRDocument = {
    version: '3.0.0',
    meta: { name: 'Precomputed Blur' },
    comment: 'This is a test pipeline demonstrating resize, generation, and blur phases.',
    entryPoint: 'fn_main_cpu',
    inputs: [
      { id: 'u_kernel_size', type: 'int', comment: 'Size of the blur kernel' }
    ],
    structs: [],
    resources: [
      {
        id: 't_input',
        type: 'texture2d',
        format: TextureFormat.RGBA8,
        size: { mode: 'fixed', value: [4, 4] },
        persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
      },
      {
        id: 't_output',
        type: 'texture2d',
        format: TextureFormat.RGBA8,
        size: { mode: 'fixed', value: [4, 4] },
        persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
      },
      {
        id: 'b_weights',
        type: 'buffer',
        dataType: 'float4',
        size: { mode: 'cpu_driven' },
        persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
      }
    ],
    functions: [
      {
        id: 'fn_main_cpu',
        type: 'cpu',
        comment: 'Main CPU Orchestrator',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          // 1. Resize Weights
          { id: 'resize_w', op: 'cmd_resize_resource', resource: 'b_weights', size: 'u_kernel_size' },

          // 2. Initialize input texture to white (1,1,1,1)
          { id: 'cmd_init', op: 'cmd_dispatch', func: 'fn_init_input', dispatch: [4, 4, 1], exec_in: 'resize_w' },

          // 3. Dispatch Gen (4 Threads)
          { id: 'cmd_gen', op: 'cmd_dispatch', func: 'fn_gen_kernel', dispatch: [4, 1, 1], comment: 'Generate weights in parallel', exec_in: 'cmd_init' },

          // 4. Dispatch Blur (1 Thread for test)
          { id: 'cmd_blur', op: 'cmd_dispatch', func: 'fn_blur', dispatch: [1, 1, 1], u_kernel_size: 'u_kernel_size', exec_in: 'cmd_gen' }
        ]
      },
      {
        id: 'fn_init_input',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'th_id', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'x', op: 'vec_get_element', vec: 'th_id', index: 0 },
          { id: 'y', op: 'vec_get_element', vec: 'th_id', index: 1 },
          { id: 'coords', op: 'float2', x: 'x', y: 'y' },
          { id: 'white', op: 'float4', x: 1, y: 1, z: 1, w: 1 },
          { id: 'store', op: 'texture_store', tex: 't_input', coords: 'coords', value: 'white' }
        ]
      },
      {
        id: 'fn_gen_kernel',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          // Get ThreadID.x
          { id: 'th_id', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'idx', op: 'vec_get_element', vec: 'th_id', index: 0 },

          // Compute Value = idx * 0.1 (to avoid clamping in accumulation)
          { id: 'val', op: 'math_mul', a: 'idx', b: 0.1 },
          { id: 'v_val', op: 'float4', x: 'val', y: 'val', z: 'val', w: 'val' },

          // Store: b_weights[idx] = v_val
          { id: 'store', op: 'buffer_store', buffer: 'b_weights', index: 'idx', value: 'v_val' }
        ]
      },
      {
        id: 'fn_blur',
        type: 'shader',
        inputs: [{ id: 'u_kernel_size', type: 'int' }],
        outputs: [],
        localVars: [{ id: 'v_color', type: 'float4', initialValue: [0, 0, 0, 0] }],
        nodes: [
          { id: 'th_id', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'x', op: 'vec_get_element', vec: 'th_id', index: 0 },
          { id: 'y', op: 'vec_get_element', vec: 'th_id', index: 1 },
          { id: 'coords', op: 'float2', x: 'x', y: 'y' },

          // Loop over kernel size
          { id: 'loop', op: 'flow_loop', start: 0, end: 'u_kernel_size', exec_body: 'set', exec_completed: 'store' },

          // Loop body
          { id: 'idx', op: 'loop_index', loop: 'loop' },
          { id: 'w_val', op: 'buffer_load', buffer: 'b_weights', index: 'idx' },
          { id: 'tex_val', op: 'texture_sample', tex: 't_input', uv: [0.5, 0.5] },
          { id: 'prev', op: 'var_get', var: 'v_color' },
          { id: 'new_val', op: 'math_mad', a: 'tex_val', b: 'w_val', c: 'prev' },
          { id: 'set', op: 'var_set', var: 'v_color', val: 'new_val' },

          // Store result after loop
          { id: 'final_color', op: 'var_get', var: 'v_color' },
          { id: 'store', op: 'texture_store', tex: 't_output', coords: 'coords', value: 'final_color' }
        ]
      }
    ]
  };

  backends.forEach(backend => {
    it(`should execute the Precomputed Blur pipeline (Resize -> Gen -> Blur) [${backend.name}]`, async () => {
      const inputs = new Map<string, RuntimeValue>();
      inputs.set('u_kernel_size', 4);

      const context = await backend.execute(ir, 'fn_main_cpu', inputs);

      // Assertions
      const log = context.log;

      // 1. Check Resize
      const resizeAction = log.find(a => a.type === 'resize');
      expect(resizeAction).toBeDefined();

      // 2. Check Buffer Data
      const buffer = context.getResource('b_weights');
      expect((buffer.data?.[0] as number[])[0]).toBeCloseTo(0, 5);
      expect((buffer.data?.[1] as number[])[0]).toBeCloseTo(0.1, 5);
      expect((buffer.data?.[2] as number[])[0]).toBeCloseTo(0.2, 5);
      expect((buffer.data?.[3] as number[])[0]).toBeCloseTo(0.3, 5);

      // 3. Verify Texture Store (Convolution result)
      // Sum = 1.0 * (0.0 + 0.1 + 0.2 + 0.3) = 0.6
      const output = context.getResource('t_output');
      const rgba = output.data?.[0] as number[];
      expect(rgba[0]).toBeCloseTo(0.6, 5);
      expect(rgba[1]).toBeCloseTo(0.6, 5);
      expect(rgba[2]).toBeCloseTo(0.6, 5);
      expect(rgba[3]).toBeCloseTo(0.6, 5);
    });
  });
});
