import { describe } from 'vitest';
import { runGraphTest } from './test-runner';

describe('Compliance: Quaternions', () => {

  runGraphTest('Quaternion Identity Multiplication', [
    { id: 'node_0', op: 'quat_identity' },
    // Manual construct Identity: [0, 0, 0, 1]
    { id: 'node_1', op: 'quat', x: 0, y: 0, z: 0, w: 1 },
    // Mul
    { id: 'mul', op: 'quat_mul', a: 'node_0', b: 'node_1' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'mul' }
  ], 'res', [0, 0, 0, 1]);

  runGraphTest('Quaternion Rotation (90 deg Z)', [
    // Rotate [1, 0, 0] by 90 deg around Z -> [0, 1, 0]
    // q = [0, 0, sin(45), cos(45)] = [0, 0, 0.707, 0.707]
    {
      id: 'q',
      op: 'quat',
      x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4)
    },
    { id: 'v', op: 'float3', x: 1, y: 0, z: 0 },
    { id: 'rot', op: 'quat_rotate', q: 'q', v: 'v' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'rot' }
  ], 'res', [0, 1, 0]);

  runGraphTest('Quaternion Slerp (0 to 90)', [
    // q0 = Identity (0 deg)
    // q1 = 90 deg Z ([0, 0, 0.707, 0.707])
    // t = 0.5 -> 45 deg Z ([0, 0, 0.382, 0.923])
    { id: 'q0', op: 'quat_identity' },
    { id: 'q1', op: 'quat', x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) },
    { id: 'slerp', op: 'quat_slerp', a: 'q0', b: 'q1', t: 0.5 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'slerp' }
  ], 'res', [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]);

  runGraphTest('Quaternion to float4x4 (Identity)', [
    { id: 'q', op: 'quat_identity' },
    { id: 'm', op: 'quat_to_float4x4', q: 'q' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'm' }
  ], 'res', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

});
