import { describe } from 'vitest';
import { runGraphTest, runGraphErrorTest } from './test-runner';

describe('Conformance: Runtime Edge Cases', () => {

  // ----------------------------------------------------------------
  // Math Limits
  // ----------------------------------------------------------------
  runGraphTest('Div by Zero (CPU)', [
    { id: 'op', op: 'math_div', a: 1.0, b: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', Infinity);

  runGraphTest('Sqrt Negative', [
    { id: 'op', op: 'math_sqrt', val: -1.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', NaN);

  runGraphTest('Log Zero', [
    { id: 'op', op: 'math_log', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', -Infinity);

  // ----------------------------------------------------------------
  // Matrix Degradation
  // ----------------------------------------------------------------
  // Current implementation returns input for inverse if singular (placeholder behavior)
  runGraphTest('Inverse Singular Matrix (Fallback)', [
    { id: 'm', op: 'mat_identity', size: 4 }, // is Identity singular? No.
    // Construct a singular matrix (all zeros) using manual float array construction logic
    // We don't have mat_from_array directly, but float4x4 takes vals.
    // We need a node that outputs an array of 0s.
    { id: 'zeros', op: 'array_construct', length: 16, fill: 0 },
    { id: 'bad_mat', op: 'float4x4', vals: 'zeros' },
    { id: 'inv', op: 'mat_inverse', val: 'bad_mat' },
    // Expected fallback is return val (zeros)
    { id: 'extract', op: 'vec_get_element', vec: 'inv', index: 0 }, // first element
    { id: 'sink', op: 'var_set', var: 'res', val: 'extract' } // Should be 0
  ], 'res', 0);

  // ----------------------------------------------------------------
  // Recursion Limit (Runtime)
  // ----------------------------------------------------------------
  runGraphErrorTest('Runtime Recursion Detection', [
    { id: 'call', op: 'call_func', func: 'main' }, // Calls itself (entry point in test runner is 'main')
    { id: 'sink', op: 'var_set', var: 'res', val: 'call' }
  ], /Recursion detected/);

  // ----------------------------------------------------------------
  // NaN & Infinity
  // ----------------------------------------------------------------
  runGraphTest('NaN != NaN (Identity)', [
    { id: 'n', op: 'math_sqrt', val: -1.0 },
    { id: 'eq', op: 'math_eq', a: 'n', b: 'n' }, // NaN == NaN is false
    { id: 'res_int', op: 'static_cast_int', val: 'eq' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'res_int' } // 0 (false)
  ], 'res', 0.0);

  runGraphTest('Inf == Inf', [
    { id: 'inf', op: 'math_div', a: 1.0, b: 0.0 },
    { id: 'eq', op: 'math_eq', a: 'inf', b: 'inf' },
    { id: 'res_int', op: 'static_cast_int', val: 'eq' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'res_int' }
  ], 'res', 1.0);

  // ----------------------------------------------------------------
  // 32-Bit Integer Wrapping
  // ----------------------------------------------------------------
  // 2^31 = 2147483648. Max int32 is 2147483647.
  // Casting 2147483648 should wrap to -2147483648 via | 0
  runGraphTest('Int32 Overflow Wrap', [
    { id: 'huge', op: 'math_pow', a: 2.0, b: 31.0 }, // 2147483648
    { id: 'casted', op: 'static_cast_int', val: 'huge' },
    { id: 'back', op: 'static_cast_float', val: 'casted' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'back' }
  ], 'res', -2147483648);

});
