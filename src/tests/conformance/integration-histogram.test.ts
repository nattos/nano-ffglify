
import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { IRDocument, TextureFormat, DataType, BuiltinName } from '../../ir/types';

const backends = cpuBackends;

describe('Conformance: Integration - Histogram Pipeline', () => {
  if (backends.length === 0) {
    it.skip('Skipping histogram tests (no compatible backend)', () => { });
    return;
  }

  // ----------------------------------------------------------------
  // Test 1: Atomic histogram accumulation + cmd_copy_buffer + readback
  // ----------------------------------------------------------------
  // 8 threads atomicAdd to 4-bin counter, copy to int buffer, then a
  // readback shader loads from the int buffer and writes to a float buffer.
  // This tests the full atomic → copy → buffer_load pipeline.
  describe('Atomic accumulation, copy buffer, and readback', () => {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Atomic Accum + Copy + Readback' },
      entryPoint: 'main',
      inputs: [],
      resources: [
        {
          id: 'cnt',
          type: 'atomic_counter',
          dataType: 'int',
          size: { mode: 'fixed', value: 4 },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
        },
        {
          id: 'b_copy',
          type: 'buffer',
          dataType: 'int',
          size: { mode: 'fixed', value: 4 },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
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
            // Clear atomics
            { id: 'clr', op: 'cmd_dispatch', func: 'fn_clear', threads: [4, 1, 1], exec_out: 'accum' },
            // Accumulate: 8 threads, each adds 1 to bin (gid % 4)
            { id: 'accum', op: 'cmd_dispatch', func: 'fn_accum', threads: [8, 1, 1], exec_out: 'copy' },
            // Copy atomic counter → int buffer
            { id: 'copy', op: 'cmd_copy_buffer', src: 'cnt', dst: 'b_copy', exec_out: 'readback' },
            // Readback: shader loads from int buffer, casts to float, writes to float buffer
            { id: 'readback', op: 'cmd_dispatch', func: 'fn_readback', threads: [4, 1, 1] },
          ]
        },
        {
          id: 'fn_clear',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          workgroupSize: [64, 1, 1],
          nodes: [
            { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'clr', op: 'atomic_store', counter: 'cnt', index: 'gid.x', value: 0 }
          ]
        },
        {
          id: 'fn_accum',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          workgroupSize: [64, 1, 1],
          nodes: [
            { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'gf', op: 'static_cast_float', val: 'gid.x' },
            { id: 'bin_f', op: 'math_mod', a: 'gf', b: 4.0 },
            { id: 'bin', op: 'static_cast_int', val: 'bin_f' },
            { id: 'add', op: 'atomic_add', counter: 'cnt', index: 'bin', value: 1 }
          ]
        },
        {
          id: 'fn_readback',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          workgroupSize: [64, 1, 1],
          nodes: [
            { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'val', op: 'buffer_load', buffer: 'b_copy', index: 'gid.x' },
            { id: 'vf', op: 'static_cast_float', val: 'val' },
            { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 'gid.x', value: 'vf' }
          ]
        }
      ]
    };

    backends.forEach(backend => {
      it(`Atomic accumulate → copy → buffer_load readback [${backend.name}]`, async () => {
        const ctx = await backend.execute(ir, 'main');
        try {
          const res = ctx.getResource('b_result');
          expect(res).toBeDefined();
          expect(res.data).toBeDefined();
          // 8 threads, each writes to gid%4: bins 0,1,2,3 each get 2 increments
          expect(res.data![0]).toBeCloseTo(2, 0);
          expect(res.data![1]).toBeCloseTo(2, 0);
          expect(res.data![2]).toBeCloseTo(2, 0);
          expect(res.data![3]).toBeCloseTo(2, 0);
        } finally {
          ctx.destroy();
        }
      });
    });
  });

  // ----------------------------------------------------------------
  // Test 2: cmd_draw with loadOp 'load' preserves compute output
  // ----------------------------------------------------------------
  // A compute shader fills a 4x4 texture with red. Then cmd_draw with
  // loadOp: 'load' draws a triangle on top. The pixels not covered by
  // the triangle should remain red.
  describe('Draw with loadOp load', () => {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Draw LoadOp Load' },
      entryPoint: 'main',
      inputs: [],
      structs: [
        {
          id: 'VOut',
          members: [
            { name: 'pos', type: 'float4' as DataType, builtin: 'position' as BuiltinName },
            { name: 'color', type: 'float4' as DataType, location: 0 }
          ]
        }
      ],
      resources: [
        {
          id: 'output_tex',
          type: 'texture2d',
          format: TextureFormat.RGBA8,
          size: { mode: 'fixed', value: [4, 4] },
          isOutput: true,
          persistence: { retain: false, clearOnResize: true, clearEveryFrame: false, cpuAccess: true }
        }
      ],
      functions: [
        {
          id: 'main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            // Fill output with red via compute
            { id: 'fill', op: 'cmd_dispatch', func: 'fn_fill', threads: [4, 4, 1], exec_out: 'draw' },
            // Draw green triangle on top with loadOp: 'load'
            {
              id: 'draw',
              op: 'cmd_draw',
              target: 'output_tex',
              vertex: 'fn_vs',
              fragment: 'fn_fs',
              count: 3,
              pipeline: {
                topology: 'triangle-list',
                loadOp: 'load',
              }
            }
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
          id: 'fn_vs',
          type: 'shader',
          comment: 'Vertex shader: tiny triangle in top-left corner',
          inputs: [
            { id: 'v_idx', type: 'int' as DataType, builtin: 'vertex_index' as BuiltinName }
          ],
          outputs: [
            { id: 'out', type: 'VOut' as DataType }
          ],
          localVars: [],
          nodes: [
            { id: 'vi', op: 'var_get', var: 'v_idx' },
            { id: 'vf', op: 'static_cast_float', val: 'vi' },
            // Three vertices forming a small triangle in clip space top-left
            // V0: (-1, 1), V1: (-0.5, 1), V2: (-1, 0.5) — top-left corner
            { id: 'xs', op: 'array_construct', values: [-1.0, -0.5, -1.0] },
            { id: 'ys', op: 'array_construct', values: [1.0, 1.0, 0.5] },
            { id: 'vi_i', op: 'static_cast_int', val: 'vf' },
            { id: 'px', op: 'array_extract', array: 'xs', index: 'vi_i' },
            { id: 'py', op: 'array_extract', array: 'ys', index: 'vi_i' },
            { id: 'pos', op: 'float4', x: 'px', y: 'py', z: 0.0, w: 1.0 },
            { id: 'green', op: 'float4', x: 0.0, y: 1.0, z: 0.0, w: 1.0 },
            { id: 'ret', op: 'struct_construct', type: 'VOut', values: { pos: 'pos', color: 'green' } },
            { id: 'out', op: 'func_return', val: 'ret' }
          ]
        },
        {
          id: 'fn_fs',
          type: 'shader',
          comment: 'Fragment shader: pass-through',
          inputs: [
            { id: 'in', type: 'VOut' as DataType }
          ],
          outputs: [
            { id: 'color', type: 'float4' as DataType }
          ],
          localVars: [],
          nodes: [
            { id: 'vin', op: 'var_get', var: 'in' },
            { id: 'col', op: 'struct_extract', struct: 'vin', field: 'color' },
            { id: 'ret', op: 'func_return', val: 'col' }
          ]
        }
      ]
    };

    backends.forEach(backend => {
      it(`Compute fill + draw overlay preserves compute output [${backend.name}]`, async () => {
        const ctx = await backend.execute(ir, 'main');
        try {
          const tex = ctx.getResource('output_tex');
          expect(tex).toBeDefined();
          expect(tex.data).toBeDefined();
          expect(tex.data!.length).toBeGreaterThan(0);

          // The bottom-right pixel (3,3) should still be red from the compute fill,
          // since the triangle only covers the top-left corner.
          // Texture data format: array of [r,g,b,a] arrays, indexed by (y * width + x)
          const w = tex.width;
          const pixel = tex.data![3 * w + 3] as any;
          expect(pixel).toBeDefined();
          const [r, g, b, a] = Array.isArray(pixel) ? pixel : [pixel, 0, 0, 0];
          // Red channel should be ~1.0, green ~0 (compute fill was red)
          expect(r).toBeCloseTo(1.0, 1);
          expect(g).toBeCloseTo(0.0, 1);
          expect(a).toBeCloseTo(1.0, 1);
        } finally {
          ctx.destroy();
        }
      });
    });
  });
});
