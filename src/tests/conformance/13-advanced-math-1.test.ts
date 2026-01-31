import { describe } from 'vitest';
import { runGraphTest } from './test-runner';

/**
 * @vitest-environment node
 *
 * NOTE: This file was split from 13-advanced-math.test.ts to avoid Vitest worker crashes.
 */
describe('Conformance: Advanced Math Ops - Part 1', () => {

  // ----------------------------------------------------------------
  // Rounding: fract, trunc
  // ----------------------------------------------------------------
  runGraphTest('fract(1.5)', [
    { id: 'op', op: 'math_fract', val: 1.5 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.5);

  runGraphTest('fract(-1.2)', [
    { id: 'op', op: 'math_fract', val: -1.2 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.8);

  runGraphTest('trunc(-1.5)', [
    { id: 'op', op: 'math_trunc', val: -1.5 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', -1.0);

  // ----------------------------------------------------------------
  // Classification: is_nan, is_inf
  // ----------------------------------------------------------------
  runGraphTest('is_nan(NaN)', [
    { id: 'nan', op: 'math_sqrt', val: -1.0 },
    { id: 'check', op: 'math_is_nan', val: 'nan' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'check' }
  ], 'res', true);

  runGraphTest('is_inf(1/0)', [
    { id: 'inf', op: 'math_div', a: 1.0, b: 0.0 },
    { id: 'check', op: 'math_is_inf', val: 'inf' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'check' }
  ], 'res', true);

  runGraphTest('is_finite(0)', [
    { id: 'check', op: 'math_is_finite', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'check' }
  ], 'res', true);

});
