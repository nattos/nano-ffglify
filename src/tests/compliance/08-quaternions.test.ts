import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Quaternions', () => {

  const runTest = (name: string, nodes: any[], extraEdges: any[] = [], check: (ctx: EvaluationContext) => void) => {
    it(name, () => {
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name },
        entryPoint: 'fn_main',
        inputs: [],
        structs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            size: { mode: 'fixed', value: 100 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        functions: [
          {
            id: 'fn_main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [],
            edges: []
          }
        ]
      };

      const ops = nodes.map((n, i) => ({ ...n, id: n.id || `node_${i}` }));

      const stores = ops.map((n, i) => ({
        id: `store_${i}`,
        op: 'buffer_store',
        buffer: 'b_res',
        index: i
      }));

      const edges = ops.map((n, i) => ({
        from: n.id, portOut: 'val', to: `store_${i}`, portIn: 'value', type: 'data'
      }));

      const execEdges = stores.map((_, i) => {
        if (i === 0) return null;
        return { from: `store_${i - 1}`, portOut: 'exec_out', to: `store_${i}`, portIn: 'exec_in', type: 'execution' };
      }).filter(Boolean);

      ir.functions[0].nodes = [...ops, ...stores];
      ir.functions[0].edges = [...edges, ...execEdges, ...extraEdges] as any;

      const ctx = new EvaluationContext(ir, new Map());
      const exec = new CpuExecutor(ctx);
      exec.executeEntry();

      check(ctx);
    });
  };

  runTest('Quaternion Identity', [
    { op: 'quat_identity' },
    // Manual construct Identity: [0, 0, 0, 1]
    { op: 'quat', x: 0, y: 0, z: 0, w: 1 },
    // Mul
    { id: 'mul', op: 'quat_mul', a: 'node_0', b: 'node_1' }
  ], [
    { from: 'node_0', portOut: 'val', to: 'mul', portIn: 'a', type: 'data' },
    { from: 'node_1', portOut: 'val', to: 'mul', portIn: 'b', type: 'data' }
  ], (ctx) => {
    const res = ctx.getResource('b_res');
    expect(res.data?.[0]).toEqual([0, 0, 0, 1]);
    expect(res.data?.[2]).toEqual([0, 0, 0, 1]);
  });

  runTest('Quaternion Rotation (90 deg Z)', [
    // Rotate [1, 0, 0] by 90 deg around Z -> [0, 1, 0]
    // q = [0, 0, sin(45), cos(45)] = [0, 0, 0.707, 0.707]
    {
      id: 'q',
      op: 'quat',
      x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4)
    },
    { id: 'v', op: 'vec3', x: 1, y: 0, z: 0 },
    { id: 'rot', op: 'quat_rotate', q: 'q', v: 'v' }
  ], [
    { from: 'q', portOut: 'val', to: 'rot', portIn: 'q', type: 'data' },
    { from: 'v', portOut: 'val', to: 'rot', portIn: 'v', type: 'data' }
  ], (ctx) => {
    const res = ctx.getResource('b_res');
    const v = res.data?.[2];
    expect(v[0]).toBeCloseTo(0, 5);
    expect(v[1]).toBeCloseTo(1, 5);
    expect(v[2]).toBeCloseTo(0, 5);
  });

  runTest('Quaternion Slerp (0 to 90)', [
    // q0 = Identity (0 deg)
    // q1 = 90 deg Z ([0, 0, 0.707, 0.707])
    // t = 0.5 -> 45 deg Z ([0, 0, 0.382, 0.923])
    { id: 'q0', op: 'quat_identity' },
    { id: 'q1', op: 'quat', x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) },
    { id: 'slerp', op: 'quat_slerp', a: 'q0', b: 'q1', t: 0.5 }
  ], [
    { from: 'q0', portOut: 'val', to: 'slerp', portIn: 'a', type: 'data' },
    { from: 'q1', portOut: 'val', to: 'slerp', portIn: 'b', type: 'data' }
  ], (ctx) => {
    const res = ctx.getResource('b_res');
    const q = res.data?.[2];
    // Expected: 45 deg rotation (half of 90)
    // q = [0, 0, sin(22.5), cos(22.5)]
    expect(q[0]).toBeCloseTo(0, 5);
    expect(q[1]).toBeCloseTo(0, 5);
    expect(q[2]).toBeCloseTo(Math.sin(Math.PI / 8), 5);
    expect(q[3]).toBeCloseTo(Math.cos(Math.PI / 8), 5);
  });

  runTest('Quaternion to Mat4 (Identity)', [
    { id: 'q', op: 'quat_identity' },
    { id: 'm', op: 'quat_to_mat4', q: 'q' }
  ], [
    { from: 'q', portOut: 'val', to: 'm', portIn: 'q', type: 'data' }
  ], (ctx) => {
    const res = ctx.getResource('b_res');
    const m = res.data?.[1];
    expect(m).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

});
