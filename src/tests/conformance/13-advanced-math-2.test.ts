import { describe } from 'vitest';
import { runGraphTest } from './test-runner';

/**
 * @vitest-environment node
 *
 * NOTE: This file was split from 13-advanced-math.test.ts to avoid Vitest worker crashes.
 */
describe('Conformance: Advanced Math Ops - Part 2', () => {

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
  runGraphTest('mantissa(3.0)', [
    { id: 'op', op: 'math_mantissa', val: 3.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.75);

  runGraphTest('exponent(3.0)', [
    { id: 'op', op: 'math_exponent', val: 3.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 2.0);

  runGraphTest('mantissa(1.0)', [
    { id: 'op', op: 'math_mantissa', val: 1.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.5);

  runGraphTest('exponent(1.0)', [
    { id: 'op', op: 'math_exponent', val: 1.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 1.0);

  runGraphTest('mantissa(0.0)', [
    { id: 'op', op: 'math_mantissa', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.0);

  runGraphTest('exponent(0.0)', [
    { id: 'op', op: 'math_exponent', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.0);

});
