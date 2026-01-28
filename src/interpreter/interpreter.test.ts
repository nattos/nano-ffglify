import { describe, it, expect } from 'vitest';
import { EvaluationContext, RuntimeValue } from './context';
import { CpuExecutor } from './executor';
import { IRDocument } from '../ir/types';

describe('Reference Interpreter', () => {

  it('should execute the Precomputed Blur example with Data Flow', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Precomputed Blur' },
      entryPoint: 'fn_main_cpu',
      inputs: [
        { id: 't_input', type: 'texture2d' },
        { id: 'u_kernel_size', type: 'int', default: 16 }
      ],
      resources: [
        {
          id: 't_output',
          type: 'texture2d',
          size: { mode: 'reference', ref: 't_input' },
          persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
        },
        {
          id: 'b_weights',
          type: 'buffer',
          dataType: 'float',
          size: { mode: 'cpu_driven' },
          persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
        }
      ],
      functions: [
        {
          id: 'fn_main_cpu',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            // 1. Resize Weights
            { id: 'resize_w', op: 'cmd_resize_resource', resource: 'b_weights', size: 'u_kernel_size' },

            // 2. Dispatch Gen (4 Threads)
            { id: 'cmd_gen', op: 'cmd_dispatch', func: 'fn_gen_kernel', dispatch: [4, 1, 1] },

            // 3. Dispatch Blur (1 Thread for test)
            { id: 'cmd_blur', op: 'cmd_dispatch', func: 'fn_blur', dispatch: [1, 1, 1] }
          ],
          edges: [
            { from: 'resize_w', portOut: 'exec_out', to: 'cmd_gen', portIn: 'exec_in', type: 'execution' },
            { from: 'cmd_gen', portOut: 'exec_out', to: 'cmd_blur', portIn: 'exec_in', type: 'execution' }
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
            { id: 'th_id', op: 'var_get', var: 'GlobalInvocationID' },
            { id: 'idx', op: 'vec_get_element', vec: 'th_id', index: 0 }, // Inputs via edge or prop

            // Compute Value = idx * 10
            { id: 'val', op: 'math_mul', a: 'idx', b: 10 },

            // Store: b_weights[idx] = val
            { id: 'store', op: 'buffer_store', buffer: 'b_weights', index: 'idx', value: 'val' }
          ],
          edges: [
            { from: 'th_id', portOut: 'val', to: 'idx', portIn: 'vec', type: 'data' },
            { from: 'idx', portOut: 'val', to: 'val', portIn: 'a', type: 'data' },
            { from: 'idx', portOut: 'val', to: 'store', portIn: 'index', type: 'data' },
            { from: 'val', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
          ]
        },
        {
          id: 'fn_blur',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'th_id', op: 'var_get', var: 'GlobalInvocationID' },
            { id: 'x', op: 'vec_get_element', vec: 'th_id', index: 0 },
            { id: 'y', op: 'vec_get_element', vec: 'th_id', index: 1 },
            { id: 'coords', op: 'vec2', x: 'x', y: 'y' },

            { id: 'w_val', op: 'buffer_load', buffer: 'b_weights', index: 2 }, // Should be 20
            { id: 'color', op: 'vec4', x: 'w_val', y: 0, z: 0, w: 1 },

            { id: 'store', op: 'texture_store', tex: 't_output', coords: 'coords', value: 'color' }
          ],
          edges: [
            { from: 'th_id', portOut: 'val', to: 'x', portIn: 'vec', type: 'data' },
            { from: 'th_id', portOut: 'val', to: 'y', portIn: 'vec', type: 'data' },
            { from: 'x', portOut: 'val', to: 'coords', portIn: 'x', type: 'data' },
            { from: 'y', portOut: 'val', to: 'coords', portIn: 'y', type: 'data' },
            { from: 'w_val', portOut: 'val', to: 'color', portIn: 'x', type: 'data' },
            { from: 'coords', portOut: 'val', to: 'store', portIn: 'coords', type: 'data' },
            { from: 'color', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
          ]
        }
      ]
    };

    const inputs = new Map<string, RuntimeValue>();
    inputs.set('u_kernel_size', 16);
    const context = new EvaluationContext(ir, inputs);

    // executor
    const executor = new CpuExecutor(context);
    executor.executeEntry();

    // Assertions
    const log = context.log;

    // 1. Check Resize
    const resizeAction = log.find(a => a.type === 'resize');
    expect(resizeAction).toBeDefined();

    // 2. Check Buffer Data (Data Chaining Verification)
    const buffer = context.getResource('b_weights');
    expect(buffer.data).toBeDefined();

    // Expect [0, 10, 20, 30] (from 4 threads)
    expect(buffer.data?.[0]).toBe(0);
    expect(buffer.data?.[1]).toBe(10);
    expect(buffer.data?.[2]).toBe(20);
    expect(buffer.data?.[3]).toBe(30);

    // 3. Check Blur Dispatch
    const blurAction = log.find(a => a.type === 'dispatch' && a.target === 'fn_blur');
    expect(blurAction).toBeDefined();

    // 4. Verify Texture Store (fn_blur logic)
    const output = context.getResource('t_output');
    expect(output.data).toBeDefined();
    // Index 0 (0,0) should store [20, 0, 0, 1]
    // Note: Dispatch for blur was [1,1,1] so only (0,0) written.
    expect(output.data?.[0]).toEqual([20, 0, 0, 1]);
  });

  it('should sample texture with Wrap Mode Repeat', () => {
    // 1. Setup IR with Texture and Sampler config
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Sampler Test' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [
        {
          id: 't_src',
          type: 'texture2d',
          size: { mode: 'fixed', value: [2, 2] },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false },
          sampler: { filter: 'nearest', wrap: 'repeat' } // REPEAT
        },
        {
          id: 'b_result',
          type: 'buffer',
          size: { mode: 'fixed', value: 1 },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
        }
      ],
      functions: [
        {
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'call', op: 'cmd_dispatch', func: 'fn_sample', dispatch: [1, 1, 1] }
          ],
          edges: []
        },
        {
          id: 'fn_sample',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            // Sample at (1.5, 0.5). With Repeat, this equates to (0.5, 0.5)
            // 2x2 texture. (0.5 * 2) = 1.0. Floor = 1.
            // X=1. Y=1. Index = 3.
            { id: 'uv', op: 'vec2', x: 1.5, y: 0.5 },
            { id: 'sample', op: 'texture_sample', tex: 't_src', uv: 'uv' },
            { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'sample' }
          ],
          edges: [
            { from: 'uv', portOut: 'val', to: 'sample', portIn: 'uv', type: 'data' },
            { from: 'sample', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
          ]
        }
      ]
    };

    const ctx = new EvaluationContext(ir, new Map());

    // 2. Populate Texture Manually (2x2)
    // [R, G]
    // [B, W]
    const tex = ctx.getResource('t_src');
    tex.width = 2;
    tex.height = 2;
    tex.data = [
      [1, 0, 0, 1], [0, 1, 0, 1], // Row 0: Red, Green
      [0, 0, 1, 1], [1, 1, 1, 1]  // Row 1: Blue, White (Index 3)
    ];

    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const buf = ctx.getResource('b_result');
    expect(buf.data?.[0]).toEqual([1, 1, 1, 1]); // Expect White
  });

  it('should sample texture with Clamp Mode', () => {
    // 1. Setup IR with Texture and Sampler config
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Sampler Test Clamp' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [
        {
          id: 't_src',
          type: 'texture2d',
          size: { mode: 'fixed', value: [2, 2] },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false },
          sampler: { filter: 'nearest', wrap: 'clamp' } // CLAMP
        },
        {
          id: 'b_result',
          type: 'buffer',
          size: { mode: 'fixed', value: 1 },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
        }
      ],
      functions: [
        {
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'call', op: 'cmd_dispatch', func: 'fn_sample', dispatch: [1, 1, 1] }
          ],
          edges: []
        },
        {
          id: 'fn_sample',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            // Sample at (-0.5, 0.5).
            // Clamp -> (0, 0.5).
            // U=0. X=0. V=0.5 -> Y=1.
            // Index = 1*2 + 0 = 2.
            { id: 'uv', op: 'vec2', x: -0.5, y: 0.5 },
            { id: 'sample', op: 'texture_sample', tex: 't_src', uv: 'uv' },
            { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'sample' }
          ],
          edges: [
            { from: 'uv', portOut: 'val', to: 'sample', portIn: 'uv', type: 'data' },
            { from: 'sample', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
          ]
        }
      ]
    };

    const ctx = new EvaluationContext(ir, new Map());

    const tex = ctx.getResource('t_src');
    tex.width = 2;
    tex.height = 2;
    tex.data = [
      [1, 0, 0, 1], [0, 1, 0, 1],
      [0, 0, 1, 1], [1, 1, 1, 1] // Index 2 is Blue [0,0,1,1]
    ];

    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const buf = ctx.getResource('b_result');
    expect(buf.data?.[0]).toEqual([0, 0, 1, 1]); // Expect Blue
  });
});
