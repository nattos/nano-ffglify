
import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { IRDocument, TextureFormat } from '../../ir/types';

const backends = cpuBackends;

describe('Conformance: Integration - Feedback Pipeline', () => {
  if (backends.length === 0) {
    it.skip('Skipping feedback tests (no compatible backend)', () => { });
    return;
  }

  // ----------------------------------------------------------------
  // Test 1: Fill texture → cmd_copy_texture → readback persistent texture
  // ----------------------------------------------------------------
  // Verifies that cmd_copy_texture transfers pixel data to a persistent
  // (clearEveryFrame: false, retain: true) texture, the core mechanism
  // for video feedback effects.
  describe('Copy texture to persistent feedback buffer', () => {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Copy to Persistent Texture' },
      entryPoint: 'main',
      inputs: [],
      resources: [
        {
          id: 'output_tex',
          type: 'texture2d',
          format: TextureFormat.RGBA8,
          size: { mode: 'fixed', value: [4, 4] },
          isOutput: true,
          persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: true }
        },
        {
          id: 'feedback_tex',
          type: 'texture2d',
          format: TextureFormat.RGBA8,
          size: { mode: 'fixed', value: [4, 4] },
          persistence: { retain: true, clearOnResize: true, clearEveryFrame: false, cpuAccess: true }
        },
        {
          id: 'b_result',
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
          localVars: [],
          nodes: [
            // Fill output_tex with red
            { id: 'fill', op: 'cmd_dispatch', func: 'fn_fill', threads: [4, 4, 1], exec_out: 'copy' },
            // Copy output → feedback (persistent)
            { id: 'copy', op: 'cmd_copy_texture', src: 'output_tex', dst: 'feedback_tex', exec_out: 'read' },
            // Read feedback_tex center → result buffer
            { id: 'read', op: 'cmd_dispatch', func: 'fn_readback', threads: [1, 1, 1] }
          ]
        },
        {
          id: 'fn_fill',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'red', op: 'float4', x: 1.0, y: 0.0, z: 0.0, w: 1.0 },
            { id: 'store', op: 'texture_store', tex: 'output_tex', coords: 'gid.xy', value: 'red' }
          ]
        },
        {
          id: 'fn_readback',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          workgroupSize: [1, 1, 1],
          nodes: [
            // Sample feedback_tex at center (pixel 1,1 center = UV 0.375, 0.375)
            { id: 'uv', op: 'float2', x: 0.375, y: 0.375 },
            { id: 'color', op: 'texture_sample', tex: 'feedback_tex', coords: 'uv' },
            { id: 'cr', op: 'vec_get_element', vec: 'color', index: 0 },
            { id: 'cg', op: 'vec_get_element', vec: 'color', index: 1 },
            { id: 'cb', op: 'vec_get_element', vec: 'color', index: 2 },
            { id: 'ca', op: 'vec_get_element', vec: 'color', index: 3 },
            { id: 's0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'cr', exec_out: 's1' },
            { id: 's1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'cg', exec_out: 's2' },
            { id: 's2', op: 'buffer_store', buffer: 'b_result', index: 2, value: 'cb', exec_out: 's3' },
            { id: 's3', op: 'buffer_store', buffer: 'b_result', index: 3, value: 'ca' }
          ]
        }
      ]
    };

    backends.forEach(backend => {
      it(`Fill → copy → persistent readback [${backend.name}]`, async () => {
        const ctx = await backend.execute(ir, 'main');
        try {
          const res = ctx.getResource('b_result');
          expect(res).toBeDefined();
          expect(res.data).toBeDefined();
          // feedback_tex should contain the red pixels from output_tex
          expect(res.data![0]).toBeCloseTo(1.0, 1); // R
          expect(res.data![1]).toBeCloseTo(0.0, 1); // G
          expect(res.data![2]).toBeCloseTo(0.0, 1); // B
          expect(res.data![3]).toBeCloseTo(1.0, 1); // A
        } finally {
          ctx.destroy();
        }
      });
    });
  });

  // ----------------------------------------------------------------
  // Test 2: Feedback compositing with empty feedback produces input
  // ----------------------------------------------------------------
  // When feedback_tex is empty (first frame), max(decayed_feedback, input)
  // should produce the input color since max(0, input) = input.
  describe('First-frame feedback compositing', () => {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'First Frame Feedback' },
      entryPoint: 'main',
      inputs: [],
      resources: [
        {
          id: 'src_tex',
          type: 'texture2d',
          format: TextureFormat.RGBA8,
          size: { mode: 'fixed', value: [4, 4] },
          persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: true }
        },
        {
          id: 'feedback_tex',
          type: 'texture2d',
          format: TextureFormat.RGBA8,
          size: { mode: 'fixed', value: [4, 4] },
          persistence: { retain: true, clearOnResize: true, clearEveryFrame: false, cpuAccess: true }
        },
        {
          id: 'output_tex',
          type: 'texture2d',
          format: TextureFormat.RGBA8,
          size: { mode: 'fixed', value: [4, 4] },
          isOutput: true,
          persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: true }
        },
        {
          id: 'b_result',
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
          localVars: [],
          nodes: [
            // Fill src_tex with blue
            { id: 'fill', op: 'cmd_dispatch', func: 'fn_fill', threads: [4, 4, 1], exec_out: 'composite' },
            // Composite: max(empty_feedback * decay, src) → output
            { id: 'composite', op: 'cmd_dispatch', func: 'fn_composite', threads: [4, 4, 1], exec_out: 'read' },
            // Read output center → result buffer
            { id: 'read', op: 'cmd_dispatch', func: 'fn_readback', threads: [1, 1, 1] }
          ]
        },
        {
          id: 'fn_fill',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'blue', op: 'float4', x: 0.0, y: 0.0, z: 1.0, w: 1.0 },
            { id: 'store', op: 'texture_store', tex: 'src_tex', coords: 'gid.xy', value: 'blue' }
          ]
        },
        {
          id: 'fn_composite',
          type: 'shader',
          comment: 'Simplified feedback composite: sample feedback (empty=0), decay, max with src.',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },
            // Sample feedback (empty on first frame → zeros)
            { id: 'fb', op: 'texture_sample', tex: 'feedback_tex', coords: 'nuv.xy' },
            { id: 'fb_decay', op: 'math_mul', a: 'fb', b: 0.95 },
            // Sample src
            { id: 'src', op: 'texture_sample', tex: 'src_tex', coords: 'nuv.xy' },
            // max(decayed_feedback, src)
            { id: 'combined', op: 'math_max', a: 'fb_decay', b: 'src' },
            { id: 'out', op: 'float4', xyz: 'combined.xyz', w: 1.0 },
            { id: 'store', op: 'texture_store', tex: 'output_tex', coords: 'gid.xy', value: 'out' }
          ]
        },
        {
          id: 'fn_readback',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          workgroupSize: [1, 1, 1],
          nodes: [
            { id: 'uv', op: 'float2', x: 0.375, y: 0.375 },
            { id: 'color', op: 'texture_sample', tex: 'output_tex', coords: 'uv' },
            { id: 'cr', op: 'vec_get_element', vec: 'color', index: 0 },
            { id: 'cg', op: 'vec_get_element', vec: 'color', index: 1 },
            { id: 'cb', op: 'vec_get_element', vec: 'color', index: 2 },
            { id: 'ca', op: 'vec_get_element', vec: 'color', index: 3 },
            { id: 's0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'cr', exec_out: 's1' },
            { id: 's1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'cg', exec_out: 's2' },
            { id: 's2', op: 'buffer_store', buffer: 'b_result', index: 2, value: 'cb', exec_out: 's3' },
            { id: 's3', op: 'buffer_store', buffer: 'b_result', index: 3, value: 'ca' }
          ]
        }
      ]
    };

    backends.forEach(backend => {
      it(`Empty feedback → output matches input [${backend.name}]`, async () => {
        const ctx = await backend.execute(ir, 'main');
        try {
          const res = ctx.getResource('b_result');
          expect(res).toBeDefined();
          expect(res.data).toBeDefined();
          // max(0 * 0.95, blue) = blue = (0, 0, 1, 1)
          expect(res.data![0]).toBeCloseTo(0.0, 1); // R
          expect(res.data![1]).toBeCloseTo(0.0, 1); // G
          expect(res.data![2]).toBeCloseTo(1.0, 1); // B
          expect(res.data![3]).toBeCloseTo(1.0, 1); // A
        } finally {
          ctx.destroy();
        }
      });
    });
  });
});
