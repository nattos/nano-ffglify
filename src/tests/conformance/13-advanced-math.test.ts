import { describe } from 'vitest';
import { runGraphTest } from './test-runner';

describe('Conformance: Advanced Math Ops', () => {


  // ----------------------------------------------------------------
  // Rounding: fract, trunc
  // ----------------------------------------------------------------
  runGraphTest('fract(1.5)', [
    { id: 'op', op: 'math_fract', val: 1.5 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.5);

  runGraphTest('fract(-1.2)', [
    // -1.2 - floor(-1.2) = -1.2 - (-2.0) = 0.8
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

  // ----------------------------------------------------------------
  // Subnormal
  // ----------------------------------------------------------------
  runGraphTest('flush_subnormal(1e-40)', [
    { id: 'op', op: 'math_flush_subnormal', val: 1.0e-40 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.0);

  runGraphTest('flush_subnormal(1e-30)', [
    { id: 'op', op: 'math_flush_subnormal', val: 1.0e-30 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 1.0e-30);

  // ----------------------------------------------------------------
  // Frexp (Mantissa/Exponent)
  // ----------------------------------------------------------------
  // 3.0 = 0.75 * 2^2
  runGraphTest('mantissa(3.0)', [
    { id: 'op', op: 'math_mantissa', val: 3.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.75);

  runGraphTest('exponent(3.0)', [
    { id: 'op', op: 'math_exponent', val: 3.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 2.0);

  // 1.0 = 0.5 * 2^1
  runGraphTest('mantissa(1.0)', [
    { id: 'op', op: 'math_mantissa', val: 1.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.5);

  runGraphTest('exponent(1.0)', [
    { id: 'op', op: 'math_exponent', val: 1.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 1.0);

  // 0.0
  runGraphTest('mantissa(0.0)', [
    { id: 'op', op: 'math_mantissa', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.0);

  runGraphTest('exponent(0.0)', [
    { id: 'op', op: 'math_exponent', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.0);

});
