import { describe } from 'vitest';
import { runGraphTest } from './test-runner';

describe('Conformance: Matrices', () => {

  runGraphTest('Identity Matrix 3x3', [
    { id: 'op', op: 'mat_identity', size: 3 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [1, 0, 0, 0, 1, 0, 0, 0, 1]); // Col-major 3x3 Identity

  runGraphTest('Identity Matrix 4x4', [
    { id: 'op', op: 'mat_identity', size: 4 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // Col-major 4x4 Identity

  runGraphTest('Matrix Translation (Manual Construction)', [
    // Construct Translation Matrix [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  tx, ty, tz, 1]
    // Translate x=10, y=20, z=0
    {
      id: 'mat_trans',
      op: 'float4x4',
      vals: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        10, 20, 0, 1
      ]
    },
    // Point at Origin [0, 0, 0, 1]
    { id: 'vec_p', op: 'float4', x: 0, y: 0, z: 0, w: 1 },
    // Multiply Matrix * Point
    { id: 'mul_op', op: 'mat_mul', a: 'mat_trans', b: 'vec_p' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'mul_op' }
  ], 'res', [10, 20, 0, 1]);

  runGraphTest('Matrix Multiplication (Identity)', [
    { id: 'id1', op: 'mat_identity', size: 4 },
    { id: 'id2', op: 'mat_identity', size: 4 },
    { id: 'mul_id', op: 'mat_mul', a: 'id1', b: 'id2' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'mul_id' }
  ], 'res', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  runGraphTest('float3x3 x float3 (Rotation Mock)', [
    // 90 deg rotation around Z logic test on point [1, 0, 0] -> [0, 1, 0]
    // Rotation Matrix 3x3 Z-axis 90 deg:
    // [ 0 -1  0 ]
    // [ 1  0  0 ]
    // [ 0  0  1 ]
    // Flattened (Col-Major): [0, 1, 0,  -1, 0, 0,  0, 0, 1]
    {
      id: 'rot_mat',
      op: 'float3x3',
      vals: [0, 1, 0, -1, 0, 0, 0, 0, 1]
    },
    { id: 'vec_x', op: 'float3', x: 1, y: 0, z: 0 },
    { id: 'mul_rot', op: 'mat_mul', a: 'rot_mat', b: 'vec_x' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'mul_rot' }
  ], 'res', [0, 1, 0]);

  runGraphTest('float4 x float4x4 (Pre-multiplication)', [
    // v * M (Row vector)
    // v = [1, 2, 0, 0]
    // M = Identity
    // Result = [1, 2, 0, 0]
    { id: 'v', op: 'float4', x: 1, y: 2, z: 0, w: 0 },
    { id: 'm', op: 'mat_identity', size: 4 },
    { id: 'mul_pre', op: 'mat_mul', a: 'v', b: 'm' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'mul_pre' }
  ], 'res', [1, 2, 0, 0]);

});
