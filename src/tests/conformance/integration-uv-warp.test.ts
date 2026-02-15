
import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { IRDocument, TextureFormat } from '../../ir/types';

const backends = cpuBackends;

describe('Conformance: Integration - UV Warp', () => {
  if (backends.length === 0) {
    it.skip('Skipping UV warp tests (no compatible backend)', () => { });
    return;
  }

  // Shared IR: fill src_tex with a known color, warp to dst_tex, readback center pixel.
  // strength is a global input overridden per test.
  const makeWarpIR = (): IRDocument => ({
    version: '1.0.0',
    meta: { name: 'UV Warp Test' },
    entryPoint: 'main',
    inputs: [
      { id: 'strength', type: 'float', default: 0.0 }
    ],
    resources: [
      {
        id: 'src_tex',
        type: 'texture2d',
        format: TextureFormat.RGBA8,
        size: { mode: 'fixed', value: [4, 4] },
        persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: true }
      },
      {
        id: 'dst_tex',
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
          // Fill src_tex with known color
          { id: 'fill', op: 'cmd_dispatch', func: 'fn_fill', threads: [4, 4, 1], exec_out: 'warp' },
          // Warp src_tex → dst_tex
          { id: 'warp', op: 'cmd_dispatch', func: 'fn_warp', threads: [4, 4, 1], exec_out: 'read' },
          // Read dst_tex center → result buffer
          { id: 'read', op: 'cmd_dispatch', func: 'fn_readback', threads: [1, 1, 1] }
        ]
      },
      {
        id: 'fn_fill',
        type: 'shader',
        comment: 'Fill src_tex with orange (1.0, 0.5, 0.0, 1.0)',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'color', op: 'float4', x: 1.0, y: 0.5, z: 0.0, w: 1.0 },
          { id: 'store', op: 'texture_store', tex: 'src_tex', coords: 'gid.xy', value: 'color' }
        ]
      },
      {
        id: 'fn_warp',
        type: 'shader',
        comment: 'Radial UV warp: warped_uv = 0.5 + (uv - 0.5) * max(0.01, 1 + strength * r² * 2)',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },

          { id: 'str', op: 'var_get', var: 'strength' },

          { id: 'offset', op: 'math_sub', a: 'nuv.xy', b: 0.5 },
          { id: 'r2', op: 'vec_dot', a: 'offset', b: 'offset' },
          { id: 'sr2', op: 'math_mul', a: 'str', b: 'r2' },
          { id: 'sr2x2', op: 'math_mul', a: 'sr2', b: 2.0 },
          { id: 'warp_raw', op: 'math_add', a: 1.0, b: 'sr2x2' },
          { id: 'warp', op: 'math_max', a: 'warp_raw', b: 0.01 },

          { id: 'warped_off', op: 'math_mul', a: 'offset', b: 'warp' },
          { id: 'warped_uv', op: 'math_add', a: 'warped_off', b: 0.5 },

          { id: 'color', op: 'texture_sample', tex: 'src_tex', coords: 'warped_uv' },
          { id: 'out', op: 'float4', xyz: 'color.xyz', w: 1.0 },
          { id: 'store', op: 'texture_store', tex: 'dst_tex', coords: 'gid.xy', value: 'out' }
        ]
      },
      {
        id: 'fn_readback',
        type: 'shader',
        comment: 'Read dst_tex center pixel → float buffer',
        inputs: [],
        outputs: [],
        localVars: [],
        workgroupSize: [1, 1, 1],
        nodes: [
          // UV (0.375, 0.375) = center of pixel (1,1) in a 4x4 texture
          { id: 'uv', op: 'float2', x: 0.375, y: 0.375 },
          { id: 'color', op: 'texture_sample', tex: 'dst_tex', coords: 'uv' },
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
  });

  // ----------------------------------------------------------------
  // Test 1: Identity warp (strength=0) preserves uniform color
  // ----------------------------------------------------------------
  describe('Identity warp (strength=0)', () => {
    backends.forEach(backend => {
      it(`Uniform input passes through unchanged [${backend.name}]`, async () => {
        const ir = makeWarpIR();
        const inputs = new Map<string, RuntimeValue>();
        inputs.set('strength', 0.0);

        const ctx = await backend.execute(ir, 'main', inputs);
        try {
          const res = ctx.getResource('b_result');
          expect(res).toBeDefined();
          expect(res.data).toBeDefined();
          // Orange (1.0, 0.5, 0.0, 1.0) should pass through unchanged
          expect(res.data![0]).toBeCloseTo(1.0, 1); // R
          expect(res.data![1]).toBeCloseTo(0.5, 1); // G
          expect(res.data![2]).toBeCloseTo(0.0, 1); // B
          expect(res.data![3]).toBeCloseTo(1.0, 1); // A
        } finally {
          ctx.destroy();
        }
      });
    });
  });

  // ----------------------------------------------------------------
  // Test 2: Nonzero warp with uniform input still produces same color
  // ----------------------------------------------------------------
  // With a uniform source texture, any warp still samples the same color
  // everywhere. This verifies the warp shader runs without errors and
  // the warp math doesn't introduce artifacts on uniform inputs.
  describe('Nonzero warp on uniform input', () => {
    backends.forEach(backend => {
      it(`Positive strength (inward) on uniform input [${backend.name}]`, async () => {
        const ir = makeWarpIR();
        const inputs = new Map<string, RuntimeValue>();
        inputs.set('strength', 1.0);

        const ctx = await backend.execute(ir, 'main', inputs);
        try {
          const res = ctx.getResource('b_result');
          expect(res).toBeDefined();
          expect(res.data).toBeDefined();
          // Uniform orange: warp doesn't change the sampled color
          expect(res.data![0]).toBeCloseTo(1.0, 1); // R
          expect(res.data![1]).toBeCloseTo(0.5, 1); // G
          expect(res.data![2]).toBeCloseTo(0.0, 1); // B
          expect(res.data![3]).toBeCloseTo(1.0, 1); // A
        } finally {
          ctx.destroy();
        }
      });

      it(`Negative strength (fisheye) on uniform input [${backend.name}]`, async () => {
        const ir = makeWarpIR();
        const inputs = new Map<string, RuntimeValue>();
        inputs.set('strength', -1.0);

        const ctx = await backend.execute(ir, 'main', inputs);
        try {
          const res = ctx.getResource('b_result');
          expect(res).toBeDefined();
          expect(res.data).toBeDefined();
          // Uniform orange: warp doesn't change the sampled color
          expect(res.data![0]).toBeCloseTo(1.0, 1); // R
          expect(res.data![1]).toBeCloseTo(0.5, 1); // G
          expect(res.data![2]).toBeCloseTo(0.0, 1); // B
          expect(res.data![3]).toBeCloseTo(1.0, 1); // A
        } finally {
          ctx.destroy();
        }
      });
    });
  });
});
