
import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { IRDocument, TextureFormat } from '../../ir/types';

const backends = cpuBackends;

// Test card layout on 64×64 texture:
//   Base cells = 16, square texture → 16×16 grid, cell = 4px
//   CPU precomputes: cols=16, rows=16, digit_col=7, digit_row=6
//
//   Row 0: checkerboard
//   Row 1: colour spectrum (inset: cols 1–14, static hue)
//   Rows 2–13: checkerboard + digit overlay (cols 7–9, rows 6–10)
//   Row 14: grayscale gradient (inset: cols 1–14)
//   Row 15: checkerboard
//
// Animated bell curve modulates checkerboard contrast.
// At time=0 the bell center is at slant=-0.25 (off-screen), so contrast is full.

const TEX_SIZE = 64;
const BASE_CELLS = 16;

function makeTestCardIR(): IRDocument {
  const DIGIT_1 = 29850;
  const DIGIT_2 = 29671;

  function digitNodes(prefix: string, bitmap: number, startCol: number | string, startRow: number | string): any[] {
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
    { id: 'time', op: 'builtin_get', name: 'time' },
    { id: 'number', op: 'var_get', var: 'u_number' },

    // Load grid params
    { id: 'cols', op: 'buffer_load', buffer: 'grid_params', index: 0 },
    { id: 'rows', op: 'buffer_load', buffer: 'grid_params', index: 1 },
    { id: 'digit_col', op: 'buffer_load', buffer: 'grid_params', index: 2 },
    { id: 'digit_row', op: 'buffer_load', buffer: 'grid_params', index: 3 },

    // Cell indices from integer pixel coordinates
    { id: 'gid_xf', op: 'static_cast_float', val: 'gid.x' },
    { id: 'gid_yf', op: 'static_cast_float', val: 'gid.y' },
    { id: 'tex_size', op: 'resource_get_size', resource: 'output' },
    { id: 'cx_num', op: 'math_mul', a: 'gid_xf', b: 'cols' },
    { id: 'cx_div', op: 'math_div', a: 'cx_num', b: 'tex_size.x' },
    { id: 'cell_x', op: 'math_floor', val: 'cx_div' },
    { id: 'cy_num', op: 'math_mul', a: 'gid_yf', b: 'rows' },
    { id: 'cy_div', op: 'math_div', a: 'cy_num', b: 'tex_size.y' },
    { id: 'cell_y', op: 'math_floor', val: 'cy_div' },

    // Grid lines: boundary test against left/top neighbor
    { id: 'left_x', op: 'math_sub', a: 'gid_xf', b: 1.0 },
    { id: 'lcx_num', op: 'math_mul', a: 'left_x', b: 'cols' },
    { id: 'lcx_div', op: 'math_div', a: 'lcx_num', b: 'tex_size.x' },
    { id: 'left_cell', op: 'math_floor', val: 'lcx_div' },
    { id: 'top_y', op: 'math_sub', a: 'gid_yf', b: 1.0 },
    { id: 'tcy_num', op: 'math_mul', a: 'top_y', b: 'rows' },
    { id: 'tcy_div', op: 'math_div', a: 'tcy_num', b: 'tex_size.y' },
    { id: 'top_cell', op: 'math_floor', val: 'tcy_div' },
    { id: 'dx', op: 'math_sub', a: 'cell_x', b: 'left_cell' },
    { id: 'dx_abs', op: 'math_abs', val: 'dx' },
    { id: 'is_vline', op: 'math_step', edge: 0.5, x: 'dx_abs' },
    { id: 'dy', op: 'math_sub', a: 'cell_y', b: 'top_cell' },
    { id: 'dy_abs', op: 'math_abs', val: 'dy' },
    { id: 'is_hline', op: 'math_step', edge: 0.5, x: 'dy_abs' },
    { id: 'is_gridline', op: 'math_max', a: 'is_vline', b: 'is_hline' },

    // Gradient position (smooth, for spectrum/grayscale)
    { id: 'gu', op: 'math_mul', a: 'nuv.x', b: 'cols' },

    // Row type detection
    { id: 'r1_lo', op: 'math_step', edge: 1.0, x: 'cell_y' },
    { id: 'r1_hi', op: 'math_step', edge: 2.0, x: 'cell_y' },
    { id: 'is_row1', op: 'math_sub', a: 'r1_lo', b: 'r1_hi' },
    { id: 'gray_row', op: 'math_sub', a: 'rows', b: 2.0 },
    { id: 'gray_row_p1', op: 'math_add', a: 'gray_row', b: 1.0 },
    { id: 'rg_lo', op: 'math_step', edge: 'gray_row', x: 'cell_y' },
    { id: 'rg_hi', op: 'math_step', edge: 'gray_row_p1', x: 'cell_y' },
    { id: 'is_gray_row', op: 'math_sub', a: 'rg_lo', b: 'rg_hi' },

    // Gradient inset
    { id: 'cols_m1', op: 'math_sub', a: 'cols', b: 1.0 },
    { id: 'inset_lo', op: 'math_step', edge: 1.0, x: 'cell_x' },
    { id: 'inset_hi', op: 'math_step', edge: 'cols_m1', x: 'cell_x' },
    { id: 'is_inset', op: 'math_sub', a: 'inset_lo', b: 'inset_hi' },
    { id: 'is_spectrum', op: 'math_mul', a: 'is_row1', b: 'is_inset' },
    { id: 'is_grayscale', op: 'math_mul', a: 'is_gray_row', b: 'is_inset' },

    // Animated bell curve for checkerboard contrast
    { id: 'slant_y', op: 'math_mul', a: 'nuv.y', b: 0.5 },
    { id: 'slant_t', op: 'math_add', a: 'nuv.x', b: 'slant_y' },
    { id: 'bell_spd', op: 'math_mul', a: 'time', b: 0.3 },
    { id: 'bell_wrap', op: 'math_mod', a: 'bell_spd', b: 2.0 },
    { id: 'bell_ctr', op: 'math_sub', a: 'bell_wrap', b: 0.25 },
    { id: 'bell_d', op: 'math_sub', a: 'slant_t', b: 'bell_ctr' },
    { id: 'bell_ds', op: 'math_mul', a: 'bell_d', b: 2.0 },
    { id: 'bell_dc', op: 'math_clamp', val: 'bell_ds', min: -1.0, max: 1.0 },
    { id: 'bell_rad', op: 'math_mul', a: 'bell_dc', b: 3.14159 },
    { id: 'bell_cos', op: 'math_cos', val: 'bell_rad' },
    { id: 'bell_p1', op: 'math_add', a: 'bell_cos', b: 1.0 },
    { id: 'bell', op: 'math_mul', a: 'bell_p1', b: 0.5 },

    // Checkerboard with contrast modulation
    { id: 'ck_sum', op: 'math_add', a: 'cell_x', b: 'cell_y' },
    { id: 'ck_mod', op: 'math_mod', a: 'ck_sum', b: 2.0 },
    { id: 'checker_full', op: 'math_mix', a: 0.15, b: 0.65, t: 'ck_mod' },
    { id: 'bell_half', op: 'math_mul', a: 'bell', b: 0.5 },
    { id: 'bell_bias', op: 'math_add', a: 'bell_half', b: 0.5 },
    { id: 'checker', op: 'math_mix', a: 0.40, b: 'checker_full', t: 'bell_bias' },

    // Gradient parameter
    { id: 'cols_m2', op: 'math_sub', a: 'cols', b: 2.0 },
    { id: 'grad_raw', op: 'math_sub', a: 'gu', b: 1.0 },
    { id: 'grad_div', op: 'math_div', a: 'grad_raw', b: 'cols_m2' },
    { id: 'grad', op: 'math_clamp', val: 'grad_div', min: 0.0, max: 1.0 },

    // Colour spectrum (static hue = grad)
    { id: 'hr_fr', op: 'math_fract', val: 'grad' },
    { id: 'hr6', op: 'math_mul', a: 'hr_fr', b: 6.0 },
    { id: 'hr3', op: 'math_sub', a: 'hr6', b: 3.0 },
    { id: 'hr_abs', op: 'math_abs', val: 'hr3' },
    { id: 'hr_sub1', op: 'math_sub', a: 'hr_abs', b: 1.0 },
    { id: 'spec_r', op: 'math_clamp', val: 'hr_sub1', min: 0.0, max: 1.0 },
    { id: 'hg_off', op: 'math_add', a: 'grad', b: 0.6667 },
    { id: 'hg_fr', op: 'math_fract', val: 'hg_off' },
    { id: 'hg6', op: 'math_mul', a: 'hg_fr', b: 6.0 },
    { id: 'hg3', op: 'math_sub', a: 'hg6', b: 3.0 },
    { id: 'hg_abs', op: 'math_abs', val: 'hg3' },
    { id: 'hg_sub1', op: 'math_sub', a: 'hg_abs', b: 1.0 },
    { id: 'spec_g', op: 'math_clamp', val: 'hg_sub1', min: 0.0, max: 1.0 },
    { id: 'hb_off', op: 'math_add', a: 'grad', b: 0.3333 },
    { id: 'hb_fr', op: 'math_fract', val: 'hb_off' },
    { id: 'hb6', op: 'math_mul', a: 'hb_fr', b: 6.0 },
    { id: 'hb3', op: 'math_sub', a: 'hb6', b: 3.0 },
    { id: 'hb_abs', op: 'math_abs', val: 'hb3' },
    { id: 'hb_sub1', op: 'math_sub', a: 'hb_abs', b: 1.0 },
    { id: 'spec_b', op: 'math_clamp', val: 'hb_sub1', min: 0.0, max: 1.0 },

    // Background composition
    { id: 'ns1', op: 'math_sub', a: 1.0, b: 'is_spectrum' },
    { id: 'ns2', op: 'math_sub', a: 1.0, b: 'is_grayscale' },
    { id: 'not_special', op: 'math_mul', a: 'ns1', b: 'ns2' },
    { id: 'sr', op: 'math_mul', a: 'is_spectrum', b: 'spec_r' },
    { id: 'sg', op: 'math_mul', a: 'is_spectrum', b: 'spec_g' },
    { id: 'sb', op: 'math_mul', a: 'is_spectrum', b: 'spec_b' },
    { id: 'gscale', op: 'math_mul', a: 'is_grayscale', b: 'grad' },
    { id: 'cr', op: 'math_mul', a: 'not_special', b: 'checker' },
    { id: 'gs_cr', op: 'math_add', a: 'gscale', b: 'cr' },
    { id: 'bg_r', op: 'math_add', a: 'sr', b: 'gs_cr' },
    { id: 'bg_g', op: 'math_add', a: 'sg', b: 'gs_cr' },
    { id: 'bg_b', op: 'math_add', a: 'sb', b: 'gs_cr' },

    // Digit selection
    { id: 'abs_num', op: 'math_abs', val: 'number' },
    { id: 'mod2', op: 'math_mod', a: 'abs_num', b: 2.0 },
    { id: 'is_odd', op: 'math_step', edge: 0.5, x: 'mod2' },

    // Digit bitmaps
    ...digitNodes('d1', DIGIT_1, 'digit_col', 'digit_row'),
    ...digitNodes('d2', DIGIT_2, 'digit_col', 'digit_row'),
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

  const cpuNodes: any[] = [
    { id: 'tex_size', op: 'resource_get_size', resource: 'output' },
    { id: 'dim_min', op: 'math_min', a: 'tex_size.x', b: 'tex_size.y' },
    { id: 'cell_target', op: 'math_div', a: 'dim_min', b: BASE_CELLS },
    { id: 'cols_raw', op: 'math_div', a: 'tex_size.x', b: 'cell_target' },
    { id: 'rows_raw', op: 'math_div', a: 'tex_size.y', b: 'cell_target' },
    { id: 'cols_r', op: 'math_add', a: 'cols_raw', b: 0.5 },
    { id: 'rows_r', op: 'math_add', a: 'rows_raw', b: 0.5 },
    { id: 'cols', op: 'math_floor', val: 'cols_r' },
    { id: 'rows', op: 'math_floor', val: 'rows_r' },
    { id: 'half_cols', op: 'math_div', a: 'cols', b: 2.0 },
    { id: 'half_cols_fl', op: 'math_floor', val: 'half_cols' },
    { id: 'digit_col', op: 'math_sub', a: 'half_cols_fl', b: 1.0 },
    { id: 'half_rows', op: 'math_div', a: 'rows', b: 2.0 },
    { id: 'half_rows_fl', op: 'math_floor', val: 'half_rows' },
    { id: 'digit_row', op: 'math_sub', a: 'half_rows_fl', b: 2.0 },
    { id: 's0', op: 'buffer_store', buffer: 'grid_params', index: 0, value: 'cols', exec_out: 's1' },
    { id: 's1', op: 'buffer_store', buffer: 'grid_params', index: 1, value: 'rows', exec_out: 's2' },
    { id: 's2', op: 'buffer_store', buffer: 'grid_params', index: 2, value: 'digit_col', exec_out: 's3' },
    { id: 's3', op: 'buffer_store', buffer: 'grid_params', index: 3, value: 'digit_row', exec_out: 'dispatch' },
    { id: 'dispatch', op: 'cmd_dispatch', func: 'fn_render', threads: [TEX_SIZE, TEX_SIZE, 1], exec_out: 'readback' },
    { id: 'readback', op: 'cmd_dispatch', func: 'fn_readback', threads: [1, 1, 1] },
  ];

  return {
    version: '1.0.0',
    meta: { name: 'Test Card (conformance)' },
    entryPoint: 'main',
    inputs: [
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
        id: 'grid_params',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 4 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true },
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
        nodes: cpuNodes,
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
          // Sample 0: row 1 (spectrum), col 1 — pixel (6, 5)
          { id: 'uv0', op: 'float2', x: 6.5 / TEX_SIZE, y: 5.5 / TEX_SIZE },
          { id: 'c0', op: 'texture_sample', tex: 'output', coords: 'uv0' },
          { id: 'c0r', op: 'vec_get_element', vec: 'c0', index: 0 },
          { id: 'c0g', op: 'vec_get_element', vec: 'c0', index: 1 },
          { id: 'c0b', op: 'vec_get_element', vec: 'c0', index: 2 },
          { id: 'c0a', op: 'vec_get_element', vec: 'c0', index: 3 },
          { id: 's00', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c0r', exec_out: 's01' },
          { id: 's01', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'c0g', exec_out: 's02' },
          { id: 's02', op: 'buffer_store', buffer: 'b_result', index: 2, value: 'c0b', exec_out: 's03' },
          { id: 's03', op: 'buffer_store', buffer: 'b_result', index: 3, value: 'c0a', exec_out: 's10' },

          // Sample 1: row 1 (spectrum), col 5 — pixel (22, 5)
          { id: 'uv1', op: 'float2', x: 22.5 / TEX_SIZE, y: 5.5 / TEX_SIZE },
          { id: 'c1', op: 'texture_sample', tex: 'output', coords: 'uv1' },
          { id: 'c1r', op: 'vec_get_element', vec: 'c1', index: 0 },
          { id: 'c1g', op: 'vec_get_element', vec: 'c1', index: 1 },
          { id: 'c1b', op: 'vec_get_element', vec: 'c1', index: 2 },
          { id: 'c1a', op: 'vec_get_element', vec: 'c1', index: 3 },
          { id: 's10', op: 'buffer_store', buffer: 'b_result', index: 4, value: 'c1r', exec_out: 's11' },
          { id: 's11', op: 'buffer_store', buffer: 'b_result', index: 5, value: 'c1g', exec_out: 's12' },
          { id: 's12', op: 'buffer_store', buffer: 'b_result', index: 6, value: 'c1b', exec_out: 's13' },
          { id: 's13', op: 'buffer_store', buffer: 'b_result', index: 7, value: 'c1a', exec_out: 's20' },

          // Sample 2: row 14 (grayscale), col 1 — pixel (6, 57)
          { id: 'uv2', op: 'float2', x: 6.5 / TEX_SIZE, y: 57.5 / TEX_SIZE },
          { id: 'c2', op: 'texture_sample', tex: 'output', coords: 'uv2' },
          { id: 'c2r', op: 'vec_get_element', vec: 'c2', index: 0 },
          { id: 'c2g', op: 'vec_get_element', vec: 'c2', index: 1 },
          { id: 'c2b', op: 'vec_get_element', vec: 'c2', index: 2 },
          { id: 'c2a', op: 'vec_get_element', vec: 'c2', index: 3 },
          { id: 's20', op: 'buffer_store', buffer: 'b_result', index: 8, value: 'c2r', exec_out: 's21' },
          { id: 's21', op: 'buffer_store', buffer: 'b_result', index: 9, value: 'c2g', exec_out: 's22' },
          { id: 's22', op: 'buffer_store', buffer: 'b_result', index: 10, value: 'c2b', exec_out: 's23' },
          { id: 's23', op: 'buffer_store', buffer: 'b_result', index: 11, value: 'c2a', exec_out: 's30' },

          // Sample 3: row 14 (grayscale), col 13 — pixel (54, 57)
          { id: 'uv3', op: 'float2', x: 54.5 / TEX_SIZE, y: 57.5 / TEX_SIZE },
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

  describe('16×16 grid, spectrum/grayscale inset, u_number=1', () => {
    backends.forEach(backend => {
      it(`Spectrum in row 1, grayscale in row 14 [${backend.name}]`, async () => {
        const ir = makeTestCardIR();
        const inputs = new Map<string, RuntimeValue>();
        inputs.set('u_number', 1);

        const ctx = await backend.execute(ir, 'main', inputs);
        try {
          const res = ctx.getResource('b_result');
          expect(res).toBeDefined();
          expect(res.data).toBeDefined();
          const d = res.data!;

          // Sample 0: row 1 col 1 — spectrum, grad≈0.036, hue≈0.036 → red-ish
          expect(d[0]).toBeGreaterThan(0.8);  // R high
          expect(d[1]).toBeLessThan(0.5);     // G low-moderate
          expect(d[2]).toBeLessThan(0.1);     // B very low
          expect(d[3]).toBeCloseTo(1.0, 1);   // A = 1

          // Sample 1: row 1 col 5 — spectrum, grad≈0.321 → green
          expect(d[4]).toBeLessThan(0.3);     // R low
          expect(d[5]).toBeGreaterThan(0.8);  // G high
          expect(d[6]).toBeLessThan(0.1);     // B very low
          expect(d[7]).toBeCloseTo(1.0, 1);   // A = 1

          // Sample 2: row 14 col 1 — grayscale, grad≈0.036 → dark
          expect(d[8]).toBeLessThan(0.1);     // R low
          expect(d[9]).toBeLessThan(0.1);     // G low
          expect(d[10]).toBeLessThan(0.1);    // B low
          expect(d[11]).toBeCloseTo(1.0, 1);  // A = 1

          // Sample 3: row 14 col 13 — grayscale, grad≈0.893 → bright
          expect(d[12]).toBeGreaterThan(0.8); // R high
          expect(d[13]).toBeGreaterThan(0.8); // G high
          expect(d[14]).toBeGreaterThan(0.8); // B high
          expect(d[15]).toBeCloseTo(1.0, 1);  // A = 1
        } finally {
          ctx.destroy();
        }
      });
    });
  });
});
