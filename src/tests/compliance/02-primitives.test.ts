import { describe, expect } from 'vitest';
import { runParametricTest } from './test-runner';

describe('Compliance: Primitives and Operators', () => {

  const bufferDef = {
    id: 'b_result',
    type: 'buffer',
    size: { mode: 'fixed', value: 100 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
  };

  interface TestCase {
    op: string;
    args: Record<string, any>;
    expected: any;
  }

  const runBatchTest = (suiteName: string, cases: TestCase[]) => {
    // Construct Nodes
    const nodes = cases.flatMap((c, i) => [
      { id: `op_${i}`, op: c.op, ...c.args },
      { id: `store_${i}`, op: 'buffer_store', buffer: 'b_result', index: i, value: `op_${i}` }
    ]);

    // Construct Execution Chain Edges (store_0 -> store_1 -> ...)
    const execEdges = cases.map((_, i) => {
      if (i === 0) return null;
      return {
        from: `store_${i - 1}`, portOut: 'exec_out',
        to: `store_${i}`, portIn: 'exec_in',
        type: 'execution'
      };
    }).filter(Boolean) as any[];

    runParametricTest(suiteName, nodes, (ctx) => {
      const res = ctx.getResource('b_result');

      cases.forEach((c, i) => {
        const val = res.data?.[i];
        try {
          if (typeof c.expected === 'number') {
            expect(val).toBeCloseTo(c.expected, 5);
          } else if (Array.isArray(c.expected)) {
            expect(val).toBeDefined();
            expect(val).toHaveLength(c.expected.length);
            (val as number[]).forEach((v, idx) => expect(v).toBeCloseTo(c.expected[idx], 5));
          } else {
            expect(val).toEqual(c.expected);
          }
        } catch (e: any) {
          throw new Error(`Test Case '${c.op}' #${i} failed.\nargs: ${JSON.stringify(c.args)}\nExpected: ${JSON.stringify(c.expected)}\nReceived: ${JSON.stringify(val)}\nOriginal: ${e.message}`);
        }
      });
    }, [bufferDef], execEdges);
  };

  runBatchTest('Unary Operators', [
    { op: 'math_abs', args: { val: -5 }, expected: 5 },
    { op: 'math_abs', args: { val: 5 }, expected: 5 },
    { op: 'math_floor', args: { val: 5.9 }, expected: 5 },
    { op: 'math_floor', args: { val: -5.1 }, expected: -6 },
    { op: 'math_ceil', args: { val: 5.1 }, expected: 6 },
    { op: 'math_ceil', args: { val: -5.9 }, expected: -5 },
    // Vector Unary Support (Ops must handle arrays)
    { op: 'math_abs', args: { val: [-1, -2] }, expected: [1, 2] },
    { op: 'math_floor', args: { val: [1.9, 2.1] }, expected: [1, 2] },
    { op: 'vec_length', args: { a: [3, 4] }, expected: 5 },
    { op: 'vec_normalize', args: { a: [3, 4] }, expected: [0.6, 0.8] },
  ]);

  runBatchTest('Binary Operators', [
    { op: 'math_add', args: { a: 10, b: 20 }, expected: 30 },
    { op: 'math_sub', args: { a: 10, b: 20 }, expected: -10 },
    { op: 'math_mul', args: { a: 6, b: 7 }, expected: 42 },
    { op: 'math_div', args: { a: 20, b: 4 }, expected: 5 },
    { op: 'math_mod', args: { a: 7, b: 4 }, expected: 3 },
    { op: 'math_gt', args: { a: 10, b: 5 }, expected: true },
    { op: 'math_gt', args: { a: 5, b: 10 }, expected: false },
    { op: 'math_min', args: { a: 10, b: 20 }, expected: 10 },
    { op: 'math_max', args: { a: 10, b: 20 }, expected: 20 },
    { op: 'math_pow', args: { a: 2, b: 3 }, expected: 8 },
    { op: 'math_pow', args: { a: 2, b: 3 }, expected: 8 },
    { op: 'math_atan2', args: { a: 10, b: 0 }, expected: Math.PI / 2 },
    // Vector
    { op: 'vec_dot', args: { a: [1, 0, 0], b: [0, 1, 0] }, expected: 0 },
    { op: 'vec_dot', args: { a: [1, 2], b: [3, 4] }, expected: 11 },
  ]);

  runBatchTest('Transcendental & Constants', [
    // Constants
    { op: 'math_pi', args: {}, expected: Math.PI },
    { op: 'math_e', args: {}, expected: Math.E },
    // Trigonometry
    { op: 'math_sin', args: { val: 0 }, expected: 0 },
    { op: 'math_sin', args: { val: Math.PI / 2 }, expected: 1 },
    { op: 'math_cos', args: { val: 0 }, expected: 1 },
    { op: 'math_cos', args: { val: Math.PI }, expected: -1 },
    { op: 'math_tan', args: { val: 0 }, expected: 0 },
    // Hyperbolic
    { op: 'math_tanh', args: { val: 0 }, expected: 0 }, // Squash function
    { op: 'math_tanh', args: { val: 100 }, expected: 1 },
    // Exponential / Log / Sqrt
    { op: 'math_exp', args: { val: 1 }, expected: Math.E },
    { op: 'math_log', args: { val: Math.E }, expected: 1 },
    { op: 'math_sqrt', args: { val: 16 }, expected: 4 },
    // Sign
    { op: 'math_sign', args: { val: -5 }, expected: -1 },
    { op: 'math_sign', args: { val: 5 }, expected: 1 },
    { op: 'math_sign', args: { val: 0 }, expected: 0 },
    // Vector Transcendentals (Broadcasting)
    { op: 'math_sqrt', args: { val: [4, 9, 16] }, expected: [2, 3, 4] },
    { op: 'math_sin', args: { val: [0, Math.PI / 2] }, expected: [0, 1] }
  ]);

  runBatchTest('Ternary Operators', [
    { op: 'math_clamp', args: { val: 10, min: 0, max: 5 }, expected: 5 },
    { op: 'math_clamp', args: { val: -10, min: 0, max: 5 }, expected: 0 },
    { op: 'math_clamp', args: { val: 3, min: 0, max: 5 }, expected: 3 },
    { op: 'math_mad', args: { a: 2, b: 3, c: 4 }, expected: 10 }, // 2*3 + 4
    { op: 'vec_mix', args: { a: [0, 0], b: [10, 10], t: 0.5 }, expected: [5, 5] },
  ]);

  runBatchTest('Color Operations', [
    {
      op: 'color_mix',
      args: { a: [1, 0, 0, 1], b: [0, 1, 0, 0.5] },
      expected: [0.5, 0.5, 0, 1]
    },
    {
      op: 'color_mix',
      args: { a: [0, 0, 0, 0], b: [0, 0, 1, 0.5] },
      expected: [0, 0, 1, 0.5]
    }
  ]);

  runBatchTest('Constructors and Swizzles', [
    { op: 'float2', args: { x: 1, y: 2 }, expected: [1, 2] },
    { op: 'float3', args: { x: 1, y: 2, z: 3 }, expected: [1, 2, 3] },
    { op: 'float4', args: { x: 1, y: 2, z: 3, w: 4 }, expected: [1, 2, 3, 4] },
    { op: 'vec_swizzle', args: { vec: [1, 2, 3, 4], channels: 'x' }, expected: 1 },
    { op: 'vec_swizzle', args: { vec: [1, 2, 3, 4], channels: 'wzyx' }, expected: [4, 3, 2, 1] },
    { op: 'vec_swizzle', args: { vec: [1, 2], channels: 'yxy' }, expected: [2, 1, 2] },
    { op: 'vec_get_element', args: { vec: [10, 20, 30], index: 1 }, expected: 20 },
  ]);

  runBatchTest('Logic & Comparison', [
    { op: 'math_lt', args: { a: 5, b: 10 }, expected: true },
    { op: 'math_lt', args: { a: 10, b: 5 }, expected: false },
    { op: 'math_le', args: { a: 5, b: 5 }, expected: true },
    { op: 'math_le', args: { a: 5, b: 4 }, expected: false },
    { op: 'math_ge', args: { a: 5, b: 5 }, expected: true },
    { op: 'math_ge', args: { a: 4, b: 5 }, expected: false },
    { op: 'math_eq', args: { a: 5, b: 5 }, expected: true },
    { op: 'math_eq', args: { a: 5, b: 6 }, expected: false },
    { op: 'math_neq', args: { a: 5, b: 6 }, expected: true },
    { op: 'math_neq', args: { a: 5, b: 5 }, expected: false },
    // Logical
    { op: 'math_and', args: { a: 1, b: 1 }, expected: true },
    { op: 'math_and', args: { a: 1, b: 0 }, expected: false },
    { op: 'math_or', args: { a: 0, b: 1 }, expected: true },
    { op: 'math_or', args: { a: 0, b: 0 }, expected: false },
    { op: 'math_xor', args: { a: 1, b: 0 }, expected: true },
    { op: 'math_xor', args: { a: 1, b: 1 }, expected: false },
    { op: 'math_not', args: { val: 0 }, expected: true },
    { op: 'math_not', args: { val: 1 }, expected: false },
  ]);

});
