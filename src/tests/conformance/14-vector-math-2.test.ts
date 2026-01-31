import { describe } from 'vitest';
import { runGraphTest } from './test-runner';

/**
 * @vitest-environment node
 *
 * NOTE: This file was split from 14-vector-math.test.ts to avoid Vitest worker crashes.
 */
describe('Conformance: Vector Math Ops - Part 2', () => {

  // ----------------------------------------------------------------
  // Vector Mix with Boolean-like Vector
  // ----------------------------------------------------------------
  runGraphTest('vec_mix with vec_gt', [
    { id: 'red', op: 'float3', x: 1, y: 0, z: 0 },
    { id: 'blue', op: 'float3', x: 0, y: 0, z: 1 },
    { id: 'c_lhs', op: 'float3', x: 10, y: 0, z: 0 },
    { id: 'c_rhs', op: 'float3', x: 5, y: 5, z: 5 },
    { id: 'cond', op: 'math_gt', a: 'c_lhs', b: 'c_rhs' }, // [1, 0, 0]
    { id: 'mix', op: 'vec_mix', a: 'blue', b: 'red', t: 'cond' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'mix' }
  ], 'res', [1, 0, 1]);

  // ----------------------------------------------------------------
  // Vector Clamp
  // ----------------------------------------------------------------
  runGraphTest('float3_clamp', [
    { id: 'val', op: 'float3', x: -5, y: 5, z: 15 },
    { id: 'min', op: 'float3', x: 0, y: 0, z: 0 },
    { id: 'max', op: 'float3', x: 10, y: 10, z: 10 },
    { id: 'op', op: 'math_clamp', val: 'val', min: 'min', max: 'max' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [0, 5, 10]);

  // ----------------------------------------------------------------
  // Vector IsNan
  // ----------------------------------------------------------------
  runGraphTest('float2_is_nan', [
    { id: 'v_dummy', op: 'var_get', var: 'u_dummy' },
    { id: 'v_neg', op: 'math_sub', a: 'v_dummy', b: 1.0 },
    { id: 'nan', op: 'math_sqrt', val: 'v_neg' },
    { id: 'vec', op: 'float2', x: 10, y: 'nan' },
    { id: 'check', op: 'math_is_nan', val: 'vec' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'check' }
  ], 'res', [0.0, 1.0]);

});
