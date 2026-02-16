
import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { IRDocument, TextureFormat } from '../../ir/types';

const backends = cpuBackends;

// Revised test card layout (8×8 grid on 64×64 texture, cell = 8px):
//   Row 0: checkerboard (gray 0.35/0.50)
//   Row 1: colour spectrum (HSV, S=1, V=1, animated hue)
//   Rows 2-5: checkerboard + digit overlay (cols 3-5)
//   Row 6: grayscale gradient (0→1 left to right)
//   Row 7: checkerboard
//
// Grid lines: single-pixel dark gray (0.2) at cell boundaries.
// Digit: odd u_number → "1" in white, even → "2" in black.
// Digit at cols 3-5, rows 1-5. Must sample outside digit area for spectrum/grayscale tests.
//
// Sample points (mid-cell, avoiding grid lines AND digit area):
//   0: pixel (5,13)  → row 1, col 0: spectrum (hue≈0.078, orange-ish R=1, G≈0.47, B≈0)
//   1: pixel (20,13) → row 1, col 2: spectrum (hue≈0.3125, green R≈0.12, G=1, B≈0)
//   2: pixel (5,53)  → row 6, col 0: grayscale near 0
//   3: pixel (61,53) → row 6, col 7: grayscale near 1

const TEX_SIZE = 64;

function makeTestCardIR(): IRDocument {
  const DIGIT_1 = 29850;
  const DIGIT_2 = 29671;
  const COLS = 8;
  const ROWS = 8;

  function digitNodes(prefix: string, bitmap: number, startCol: number, startRow: number): any[] {
    return [
      { id: `${prefix}_lc`, op: 'math_sub', a: 'cell_x', b: startCol },
      { id: `${prefix}_lr`, op: 'math_sub', a: 'cell_y', b: startRow },
      { id: `${prefix}_lc_lo`, op: 'math_step', edge: 0.0, x: `${prefix}_lc` },
      { id: `${prefix}_lc_hi`, op: 'math_step', edge: 3.0, x: `${prefix}_lc` },
      { id: `${prefix}_lc_in`, op: 'math_sub', a: `${prefix}_lc_lo`, b: `${prefix}_lc_hi` },
      { id: `${prefix}_lr_lo`, op: 'math_step', edge: 0.0, x: `${prefix}_lr` },
      { id: `${prefix}_lr_hi`, op: 'math_step', edge: 5.0, x: `${prefix}_lr` },
      { id: `${prefix}_lr_in`, op: 'math_sub', a: `${prefix}_lr_lo`, b: `${prefix}_lr_hi` },
      { id: `${prefix}_in`, op: 'math_mul', a: `${prefix}_lc_in`, b: `${prefix}_lr_in` },
      { id: `${prefix}_ri3`, op: 'math_mul', a: `${prefix}_lr`, b: 3.0 },
      { id: `${prefix}_bi`, op: 'math_add', a: `${prefix}_ri3`, b: `${prefix}_lc` },
      { id: `${prefix}_pw`, op: 'math_pow', a: 2.0, b: `${prefix}_bi` },
      { id: `${prefix}_dv`, op: 'math_div', a: bitmap, b: `${prefix}_pw` },
      { id: `${prefix}_fl`, op: 'math_floor', val: `${prefix}_dv` },
      { id: `${prefix}_bit`, op: 'math_mod', a: `${prefix}_fl`, b: 2.0 },
      { id: `${prefix}_dot`, op: 'math_mul', a: `${prefix}_in`, b: `${prefix}_bit` },
    ];
  }

  const renderNodes: any[] = [
    { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
    { id: 'nuv', op: 'builtin_get', name: 'normalized_global_invocation_id' },
    { id: 'time', op: 'var_get', var: 'u_time' },
    { id: 'number', op: 'var_get', var: 'u_number' },

    // Texture size for pixel-accurate grid lines
    { id: 'tex_size', op: 'resource_get_size', resource: 'output' },
    { id: 'cell_w', op: 'math_div', a: 'tex_size.x', b: COLS },
    { id: 'cell_h', op: 'math_div', a: 'tex_size.y', b: ROWS },

    // Single-pixel grid lines (cast int gid to float)
    { id: 'gid_xf', op: 'static_cast_float', val: 'gid.x' },
    { id: 'gid_yf', op: 'static_cast_float', val: 'gid.y' },
    { id: 'gx_mod', op: 'math_mod', a: 'gid_xf', b: 'cell_w' },
    { id: 'gy_mod', op: 'math_mod', a: 'gid_yf', b: 'cell_h' },
    { id: 'vl_step', op: 'math_step', edge: 0.5, x: 'gx_mod' },
    { id: 'is_vline', op: 'math_sub', a: 1.0, b: 'vl_step' },
    { id: 'hl_step', op: 'math_step', edge: 0.5, x: 'gy_mod' },
    { id: 'is_hline', op: 'math_sub', a: 1.0, b: 'hl_step' },
    { id: 'is_gridline', op: 'math_max', a: 'is_vline', b: 'is_hline' },

    // Cell indices
    { id: 'gu', op: 'math_mul', a: 'nuv.x', b: COLS },
    { id: 'gv', op: 'math_mul', a: 'nuv.y', b: ROWS },
    { id: 'cell_x', op: 'math_floor', val: 'gu' },
    { id: 'cell_y', op: 'math_floor', val: 'gv' },

    // Row type detection
    { id: 'r1_lo', op: 'math_step', edge: 1.0, x: 'cell_y' },
    { id: 'r1_hi', op: 'math_step', edge: 2.0, x: 'cell_y' },
    { id: 'is_row1', op: 'math_sub', a: 'r1_lo', b: 'r1_hi' },
    { id: 'r6_lo', op: 'math_step', edge: 6.0, x: 'cell_y' },
    { id: 'r6_hi', op: 'math_step', edge: 7.0, x: 'cell_y' },
    { id: 'is_row6', op: 'math_sub', a: 'r6_lo', b: 'r6_hi' },

    // Checkerboard
    { id: 'ck_sum', op: 'math_add', a: 'cell_x', b: 'cell_y' },
    { id: 'ck_mod', op: 'math_mod', a: 'ck_sum', b: 2.0 },
    { id: 'checker', op: 'math_mix', a: 0.35, b: 0.50, t: 'ck_mod' },

    // Colour spectrum (row 1)
    { id: 'tscale', op: 'math_mul', a: 'time', b: 0.1 },
    { id: 'hue', op: 'math_add', a: 'nuv.x', b: 'tscale' },
    { id: 'hr_fr', op: 'math_fract', val: 'hue' },
    { id: 'hr6', op: 'math_mul', a: 'hr_fr', b: 6.0 },
    { id: 'hr3', op: 'math_sub', a: 'hr6', b: 3.0 },
    { id: 'hr_abs', op: 'math_abs', val: 'hr3' },
    { id: 'hr_sub1', op: 'math_sub', a: 'hr_abs', b: 1.0 },
    { id: 'spec_r', op: 'math_clamp', val: 'hr_sub1', min: 0.0, max: 1.0 },
    { id: 'hg_off', op: 'math_add', a: 'hue', b: 0.6667 },
    { id: 'hg_fr', op: 'math_fract', val: 'hg_off' },
    { id: 'hg6', op: 'math_mul', a: 'hg_fr', b: 6.0 },
    { id: 'hg3', op: 'math_sub', a: 'hg6', b: 3.0 },
    { id: 'hg_abs', op: 'math_abs', val: 'hg3' },
    { id: 'hg_sub1', op: 'math_sub', a: 'hg_abs', b: 1.0 },
    { id: 'spec_g', op: 'math_clamp', val: 'hg_sub1', min: 0.0, max: 1.0 },
    { id: 'hb_off', op: 'math_add', a: 'hue', b: 0.3333 },
    { id: 'hb_fr', op: 'math_fract', val: 'hb_off' },
    { id: 'hb6', op: 'math_mul', a: 'hb_fr', b: 6.0 },
    { id: 'hb3', op: 'math_sub', a: 'hb6', b: 3.0 },
    { id: 'hb_abs', op: 'math_abs', val: 'hb3' },
    { id: 'hb_sub1', op: 'math_sub', a: 'hb_abs', b: 1.0 },
    { id: 'spec_b', op: 'math_clamp', val: 'hb_sub1', min: 0.0, max: 1.0 },

    // Grayscale (row 6)
    { id: 'gray', op: 'math_mul', a: 'nuv.x', b: 1.0 },

    // Background composition
    { id: 'nr1', op: 'math_sub', a: 1.0, b: 'is_row1' },
    { id: 'nr6', op: 'math_sub', a: 1.0, b: 'is_row6' },
    { id: 'not_special', op: 'math_mul', a: 'nr1', b: 'nr6' },
    { id: 'sr', op: 'math_mul', a: 'is_row1', b: 'spec_r' },
    { id: 'sg', op: 'math_mul', a: 'is_row1', b: 'spec_g' },
    { id: 'sb', op: 'math_mul', a: 'is_row1', b: 'spec_b' },
    { id: 'gr', op: 'math_mul', a: 'is_row6', b: 'gray' },
    { id: 'cr', op: 'math_mul', a: 'not_special', b: 'checker' },
    { id: 'gr_cr', op: 'math_add', a: 'gr', b: 'cr' },
    { id: 'bg_r', op: 'math_add', a: 'sr', b: 'gr_cr' },
    { id: 'bg_g', op: 'math_add', a: 'sg', b: 'gr_cr' },
    { id: 'bg_b', op: 'math_add', a: 'sb', b: 'gr_cr' },

    // Digit selection
    { id: 'abs_num', op: 'math_abs', val: 'number' },
    { id: 'mod2', op: 'math_mod', a: 'abs_num', b: 2.0 },
    { id: 'is_odd', op: 'math_step', edge: 0.5, x: 'mod2' },

    // Digit bitmaps
    ...digitNodes('d1', DIGIT_1, 3, 1),
    ...digitNodes('d2', DIGIT_2, 3, 1),
    { id: 'digit_on', op: 'math_mix', a: 'd2_dot', b: 'd1_dot', t: 'is_odd' },
    { id: 'fill', op: 'math_mul', a: 'is_odd', b: 1.0 },

    // Apply digit
    { id: 'final_r', op: 'math_mix', a: 'bg_r', b: 'fill', t: 'digit_on' },
    { id: 'final_g', op: 'math_mix', a: 'bg_g', b: 'fill', t: 'digit_on' },
    { id: 'final_b', op: 'math_mix', a: 'bg_b', b: 'fill', t: 'digit_on' },

    // Grid line overlay
    { id: 'out_r', op: 'math_mix', a: 'final_r', b: 0.2, t: 'is_gridline' },
    { id: 'out_g', op: 'math_mix', a: 'final_g', b: 0.2, t: 'is_gridline' },
    { id: 'out_b', op: 'math_mix', a: 'final_b', b: 0.2, t: 'is_gridline' },

    { id: 'color', op: 'float4', x: 'out_r', y: 'out_g', z: 'out_b', w: 1.0 },
    { id: 'store', op: 'texture_store', tex: 'output', coords: 'gid.xy', value: 'color' },
  ];

  return {
    version: '1.0.0',
    meta: { name: 'Test Card (conformance)' },
    entryPoint: 'main',
    inputs: [
      { id: 'u_time', type: 'float', default: 0.0 },
      { id: 'u_number', type: 'int', default: 1 },
    ],
    resources: [
      {
        id: 'output',
        type: 'texture2d',
        format: TextureFormat.RGBA8,
        size: { mode: 'fixed', value: [TEX_SIZE, TEX_SIZE] },
        isOutput: true,
        persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: true },
      },
      {
        id: 'b_result',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 16 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true },
      },
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
          { id: 'render', op: 'cmd_dispatch', func: 'fn_render', threads: [TEX_SIZE, TEX_SIZE, 1], exec_out: 'readback' },
          { id: 'readback', op: 'cmd_dispatch', func: 'fn_readback', threads: [1, 1, 1] },
        ],
      },
      {
        id: 'fn_render',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: renderNodes,
      },
      {
        id: 'fn_readback',
        type: 'shader',
        comment: 'Sample 4 pixels from output and write RGBA to result buffer.',
        inputs: [],
        outputs: [],
        localVars: [],
        workgroupSize: [1, 1, 1],
        nodes: [
          // Sample 0: row 1 (spectrum), col 0 — pixel (5, 13)
          // nuv.x=5/64≈0.078, hue≈0.078 → orange (R≈1, G≈0.47, B≈0)
          { id: 'uv0', op: 'float2', x: 5.5 / TEX_SIZE, y: 13.5 / TEX_SIZE },
          { id: 'c0', op: 'texture_sample', tex: 'output', coords: 'uv0' },
          { id: 'c0r', op: 'vec_get_element', vec: 'c0', index: 0 },
          { id: 'c0g', op: 'vec_get_element', vec: 'c0', index: 1 },
          { id: 'c0b', op: 'vec_get_element', vec: 'c0', index: 2 },
          { id: 'c0a', op: 'vec_get_element', vec: 'c0', index: 3 },
          { id: 's00', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c0r', exec_out: 's01' },
          { id: 's01', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'c0g', exec_out: 's02' },
          { id: 's02', op: 'buffer_store', buffer: 'b_result', index: 2, value: 'c0b', exec_out: 's03' },
          { id: 's03', op: 'buffer_store', buffer: 'b_result', index: 3, value: 'c0a', exec_out: 's10' },

          // Sample 1: row 1 (spectrum), col 2 — pixel (20, 13)
          // nuv.x=20/64=0.3125, hue≈0.3125 → green (R≈0.12, G≈1, B≈0)
          { id: 'uv1', op: 'float2', x: 20.5 / TEX_SIZE, y: 13.5 / TEX_SIZE },
          { id: 'c1', op: 'texture_sample', tex: 'output', coords: 'uv1' },
          { id: 'c1r', op: 'vec_get_element', vec: 'c1', index: 0 },
          { id: 'c1g', op: 'vec_get_element', vec: 'c1', index: 1 },
          { id: 'c1b', op: 'vec_get_element', vec: 'c1', index: 2 },
          { id: 'c1a', op: 'vec_get_element', vec: 'c1', index: 3 },
          { id: 's10', op: 'buffer_store', buffer: 'b_result', index: 4, value: 'c1r', exec_out: 's11' },
          { id: 's11', op: 'buffer_store', buffer: 'b_result', index: 5, value: 'c1g', exec_out: 's12' },
          { id: 's12', op: 'buffer_store', buffer: 'b_result', index: 6, value: 'c1b', exec_out: 's13' },
          { id: 's13', op: 'buffer_store', buffer: 'b_result', index: 7, value: 'c1a', exec_out: 's20' },

          // Sample 2: row 6 (grayscale), col 0 — pixel (5, 53)
          { id: 'uv2', op: 'float2', x: 5.5 / TEX_SIZE, y: 53.5 / TEX_SIZE },
          { id: 'c2', op: 'texture_sample', tex: 'output', coords: 'uv2' },
          { id: 'c2r', op: 'vec_get_element', vec: 'c2', index: 0 },
          { id: 'c2g', op: 'vec_get_element', vec: 'c2', index: 1 },
          { id: 'c2b', op: 'vec_get_element', vec: 'c2', index: 2 },
          { id: 'c2a', op: 'vec_get_element', vec: 'c2', index: 3 },
          { id: 's20', op: 'buffer_store', buffer: 'b_result', index: 8, value: 'c2r', exec_out: 's21' },
          { id: 's21', op: 'buffer_store', buffer: 'b_result', index: 9, value: 'c2g', exec_out: 's22' },
          { id: 's22', op: 'buffer_store', buffer: 'b_result', index: 10, value: 'c2b', exec_out: 's23' },
          { id: 's23', op: 'buffer_store', buffer: 'b_result', index: 11, value: 'c2a', exec_out: 's30' },

          // Sample 3: row 6 (grayscale), col 7 — pixel (61, 53)
          { id: 'uv3', op: 'float2', x: 61.5 / TEX_SIZE, y: 53.5 / TEX_SIZE },
          { id: 'c3', op: 'texture_sample', tex: 'output', coords: 'uv3' },
          { id: 'c3r', op: 'vec_get_element', vec: 'c3', index: 0 },
          { id: 'c3g', op: 'vec_get_element', vec: 'c3', index: 1 },
          { id: 'c3b', op: 'vec_get_element', vec: 'c3', index: 2 },
          { id: 'c3a', op: 'vec_get_element', vec: 'c3', index: 3 },
          { id: 's30', op: 'buffer_store', buffer: 'b_result', index: 12, value: 'c3r', exec_out: 's31' },
          { id: 's31', op: 'buffer_store', buffer: 'b_result', index: 13, value: 'c3g', exec_out: 's32' },
          { id: 's32', op: 'buffer_store', buffer: 'b_result', index: 14, value: 'c3b', exec_out: 's33' },
          { id: 's33', op: 'buffer_store', buffer: 'b_result', index: 15, value: 'c3a' },
        ],
      },
    ],
  };
}

describe('Conformance: Integration - Test Card', () => {
  if (backends.length === 0) {
    it.skip('Skipping test card tests (no compatible backend)', () => { });
    return;
  }

  describe('Colour regions at time=0, u_number=1 (odd → digit 1)', () => {
    backends.forEach(backend => {
      it(`Spectrum in row 1, grayscale in row 6 [${backend.name}]`, async () => {
        const ir = makeTestCardIR();
        const inputs = new Map<string, RuntimeValue>();
        inputs.set('u_time', 0.0);
        inputs.set('u_number', 1);

        const ctx = await backend.execute(ir, 'main', inputs);
        try {
          const res = ctx.getResource('b_result');
          expect(res).toBeDefined();
          expect(res.data).toBeDefined();
          const d = res.data!;

          // Sample 0: row 1 col 0 — spectrum, hue≈0.078 → orange-ish
          expect(d[0]).toBeGreaterThan(0.8);  // R high (warm hue)
          expect(d[1]).toBeGreaterThan(0.2);  // G moderate
          expect(d[1]).toBeLessThan(0.7);
          expect(d[2]).toBeLessThan(0.1);     // B very low
          expect(d[3]).toBeCloseTo(1.0, 1);   // A = 1

          // Sample 1: row 1 col 2 — spectrum, hue≈0.3125 → green
          expect(d[4]).toBeLessThan(0.3);     // R low
          expect(d[5]).toBeGreaterThan(0.8);  // G high
          expect(d[6]).toBeLessThan(0.1);     // B very low
          expect(d[7]).toBeCloseTo(1.0, 1);   // A = 1

          // Sample 2: row 6 col 0 — grayscale, nuv.x≈0.078 → dark
          expect(d[8]).toBeLessThan(0.15);    // R low
          expect(d[9]).toBeLessThan(0.15);    // G low
          expect(d[10]).toBeLessThan(0.15);   // B low
          expect(d[11]).toBeCloseTo(1.0, 1);  // A = 1

          // Sample 3: row 6 col 7 — grayscale, nuv.x≈0.953 → bright
          expect(d[12]).toBeGreaterThan(0.85); // R high
          expect(d[13]).toBeGreaterThan(0.85); // G high
          expect(d[14]).toBeGreaterThan(0.85); // B high
          expect(d[15]).toBeCloseTo(1.0, 1);  // A = 1
        } finally {
          ctx.destroy();
        }
      });
    });
  });
});
