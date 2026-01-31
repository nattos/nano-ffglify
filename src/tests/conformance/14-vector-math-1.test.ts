import { describe } from 'vitest';
import { runGraphTest } from './test-runner';

/**
 * @vitest-environment node
 *
 * NOTE: This file was split from 14-vector-math.test.ts to avoid Vitest worker crashes.
 */
describe('Conformance: Vector Math Ops - Part 1', () => {

  // ----------------------------------------------------------------
  // Vector Arithmetic
  // ----------------------------------------------------------------
  runGraphTest('float3_add', [
    { id: 'v1', op: 'float3', x: 1, y: 2, z: 3 },
    { id: 'v2', op: 'float3', x: 4, y: 5, z: 6 },
    { id: 'op', op: 'math_add', a: 'v1', b: 'v2' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [5, 7, 9]);

  runGraphTest('float2_mul', [
    { id: 'v1', op: 'float2', x: 2, y: 3 },
    { id: 'v2', op: 'float2', x: 4, y: 5 },
    { id: 'op', op: 'math_mul', a: 'v1', b: 'v2' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [8, 15]);

  // ----------------------------------------------------------------
  // Vector Logic (0.0 / 1.0)
  // ----------------------------------------------------------------
  runGraphTest('float3_gt (Mixed Result)', [
    { id: 'v1', op: 'float3', x: 10, y: 2, z: 5 },
    { id: 'v2', op: 'float3', x: 5, y: 2, z: 10 },
    { id: 'op', op: 'math_gt', a: 'v1', b: 'v2' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [1.0, 0.0, 0.0]);

});
