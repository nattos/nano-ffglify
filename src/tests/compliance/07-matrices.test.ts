import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Matrices', () => {

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
            nodes: [
              ...nodes,
              // Store last node result to buffer definition for inspection if needed
              // But we can just inspect nodes via debug or checks.
              // For simplicity, we just run.
            ],
            edges: [] // Edges inferred from node inputs usually?
            // Wait, parametric test builder inferred edges. Here we need manual or helper.
            // Let's manually define minimal edges if needed, or rely on 'const' inputs.
          }
        ]
      };

      // Auto-connect flow for simplicity? Or just independent nodes?
      // ops.ts is pure function. we can just check results if we stored them?
      // But `executeEntry` runs all nodes in topological order.
      // We need to capture outputs.
      // Let's just use `buffer_store` to capture results like primitive tests.

      // Actually, let's use the parametric style logic manually:
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

      // Execution order
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

  runTest('Identity Matrices', [
    { op: 'mat_identity', size: 3 },
    { op: 'mat_identity', size: 4 }
  ], [], (ctx) => {
    const res = ctx.getResource('b_res');
    expect(res.data?.[0]).toHaveLength(9); // 3x3
    expect(res.data?.[0]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    expect(res.data?.[1]).toHaveLength(16); // 4x4
    expect(res.data?.[1]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  runTest('Matrix Translation (Manual Construction)', [
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
    { id: 'mul_op', op: 'mat_mul', a: 'mat_trans', b: 'vec_p' }
  ], [
    { from: 'mat_trans', portOut: 'val', to: 'mul_op', portIn: 'a', type: 'data' },
    { from: 'vec_p', portOut: 'val', to: 'mul_op', portIn: 'b', type: 'data' }
  ], (ctx) => {
    const res = ctx.getResource('b_res');
    // Result of mul is stored in buffer at index matching 'mul_op' index in nodes array (2)
    const transformed = res.data?.[2];
    expect(transformed).toEqual([10, 20, 0, 1]);
  });

  runTest('Matrix Multiplication (Identity)', [
    { id: 'id1', op: 'mat_identity', size: 4 },
    { id: 'id2', op: 'mat_identity', size: 4 },
    { id: 'mul_id', op: 'mat_mul', a: 'id1', b: 'id2' }
  ], [
    { from: 'id1', portOut: 'val', to: 'mul_id', portIn: 'a', type: 'data' },
    { from: 'id2', portOut: 'val', to: 'mul_id', portIn: 'b', type: 'data' }
  ], (ctx) => {
    const res = ctx.getResource('b_res');
    expect(res.data?.[2]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  runTest('float3x3 x float3 (Rotation Mock)', [
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
    { id: 'mul_rot', op: 'mat_mul', a: 'rot_mat', b: 'vec_x' }
  ], [
    { from: 'rot_mat', portOut: 'val', to: 'mul_rot', portIn: 'a', type: 'data' },
    { from: 'vec_x', portOut: 'val', to: 'mul_rot', portIn: 'b', type: 'data' }
  ], (ctx) => {
    const res = ctx.getResource('b_res');
    const rotated = res.data?.[2] as number[];
    // Expect approx [0, 1, 0]
    expect(rotated[0]).toBeCloseTo(0, 5);
    expect(rotated[1]).toBeCloseTo(1, 5);
    expect(rotated[2]).toBeCloseTo(0, 5);
  });

  runTest('float4 x float4x4 (Pre-multiplication)', [
    // v * M (Row vector)
    // v = [1, 2, 0, 0]
    // M = Identity
    // Result = [1, 2, 0, 0]
    { id: 'v', op: 'float4', x: 1, y: 2, z: 0, w: 0 },
    { id: 'm', op: 'mat_identity', size: 4 },
    { id: 'mul_pre', op: 'mat_mul', a: 'v', b: 'm' }
  ], [
    { from: 'v', portOut: 'val', to: 'mul_pre', portIn: 'a', type: 'data' },
    { from: 'm', portOut: 'val', to: 'mul_pre', portIn: 'b', type: 'data' }
  ], (ctx) => {
    const res = ctx.getResource('b_res');
    expect(res.data?.[2]).toEqual([1, 2, 0, 0]);
  });

});
