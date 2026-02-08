import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { IRDocument, TextureFormat } from '../../ir/types';

const backends = cpuBackends;

describe('Conformance: Integration - Noise Generator', () => {
  if (backends.length === 0) {
    it.skip('Skipping tests (no compatible backend)', () => { });
    return;
  }

  const ir: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Simple Noise Generator' },
    entryPoint: 'fn_main_cpu',
    inputs: [
      { id: 'scale', type: 'float', default: 10.0 },
      { id: 'time', type: 'float', default: 0.0 }
    ],
    resources: [
      {
        id: 'output_tex',
        type: 'texture2d',
        format: TextureFormat.RGBA8,
        size: { mode: 'fixed', value: [256, 256] },
        usage: 'storage',
        persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: true }
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
          { id: 'tex_size', op: 'resource_get_size', resource: 'output_tex' },
          { id: 'dispatch_noise', op: 'cmd_dispatch', func: 'fn_noise_gpu', dispatch: 'tex_size' }
        ]
      },
      {
        id: 'fn_noise_gpu',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'pos_f2', op: 'vec_swizzle', vec: 'gid', channels: 'xy' },
          { id: 'size_f2', op: 'resource_get_size', resource: 'output_tex' },
          { id: 'uv', op: 'math_div', a: 'pos_f2', b: 'size_f2' },
          { id: 'scale_val', op: 'var_get', var: 'scale' },
          { id: 'scaled_uv', op: 'math_mul', a: 'uv', b: 'scale_val' },
          { id: 'time_val', op: 'var_get', var: 'time' },
          { id: 'time_vec', op: 'float2', x: 'time_val', y: 'time_val' },
          { id: 'uv_animated', op: 'math_add', a: 'scaled_uv', b: 'time_vec' },
          { id: 'const_a', op: 'float2', x: 12.9898, y: 78.233 },
          { id: 'dot_val', op: 'vec_dot', a: 'uv_animated', b: 'const_a' },
          { id: 'sin_val', op: 'math_sin', val: 'dot_val' },
          { id: 'mul_val', op: 'math_mul', a: 'sin_val', b: 43758.5453 },
          { id: 'noise_val', op: 'math_fract', val: 'mul_val' },
          { id: 'color_out', op: 'float4', x: 'noise_val', y: 'noise_val', z: 'noise_val', w: 1.0 },
          { id: 'store_node', op: 'texture_store', tex: 'output_tex', coords: 'pos_f2', value: 'color_out' }
        ]
      }
    ]
  };

  backends.forEach(backend => {
    it(`should execute the Noise Generator pipeline [${backend.name}]`, async () => {
      const inputs = new Map<string, RuntimeValue>();
      inputs.set('scale', 10.0);
      inputs.set('time', 1.0);

      try {
        const context = await backend.execute(ir, 'fn_main_cpu', inputs);

        // Verify the output texture is not empty (contains non-zero values)
        const output = context.getResource('output_tex');
        expect(output.data).toBeDefined();

        // If output.data is an array of vectors/numbers, we should check if some are non-zero
        const flatData = (output.data as any).flat();
        const hasNonZero = flatData.some((v: number) => v > 0);
        expect(hasNonZero).toBe(true);
      } catch (e: any) {
        // If it's a WebGPU/WGSL error, try to get the compiled code and log it
        if (e.message.includes('WebGPU Error') || e.message.includes('WGSL')) {
          console.error("WGSL Compilation Error. Inspecting IR and generated code...");
          // We can't easily get the code from here unless the backend exposes it.
          // But we know ForceOntoGPU uses WgslGenerator.
        }
        throw e;
      }
    }, 30000);
  });
});
