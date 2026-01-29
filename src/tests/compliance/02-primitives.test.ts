import { describe, it, expect } from 'vitest';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

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

  const runParametricTest = (suiteName: string, cases: TestCase[]) => {
    it(suiteName, () => {
      const nodes = cases.flatMap((c, i) => [
        { id: `op_${i}`, op: c.op, ...c.args },
        { id: `store_${i}`, op: 'buffer_store', buffer: 'b_result', index: i, value: `op_${i}` }
      ]);

      const edges = cases.map((c, i) => ({
        from: `op_${i}`, portOut: 'val', to: `store_${i}`, portIn: 'value', type: 'data' as const
      }));

      // Serialize stores to ensure deterministic order (though they write to different indices)
      const execEdges = cases.map((_, i) => {
        if (i === 0) return null;
        return {
          from: `store_${i - 1}`, portOut: 'exec_out',
          to: `store_${i}`, portIn: 'exec_in',
          type: 'execution' as const
        };
      }).filter(Boolean) as any[];

      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: suiteName },
        entryPoint: 'fn_main',
        inputs: [],
        structs: [],
        resources: [bufferDef] as any,
        functions: [{
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes,
          edges: [...edges, ...execEdges]
        }]
      };

      const ctx = new EvaluationContext(ir, new Map());
      const exec = new CpuExecutor(ctx);
      exec.executeEntry();

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
        } catch (e) {
          throw new Error(`Test Case '${c.op}' #${i} failed.\nargs: ${JSON.stringify(c.args)}\nExpected: ${JSON.stringify(c.expected)}\nReceived: ${JSON.stringify(val)}`);
        }
      });
    });
  };

  runParametricTest('Unary Operators', [
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

  runParametricTest('Binary Operators', [
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
    // Vector
    { op: 'vec_dot', args: { a: [1, 0, 0], b: [0, 1, 0] }, expected: 0 },
    { op: 'vec_dot', args: { a: [1, 2], b: [3, 4] }, expected: 11 },
  ]);

  runParametricTest('Transcendental & Constants', [
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
    { op: 'math_tanh', args: { val: 0 }, expected: 0 }, // Squash function!
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

  runParametricTest('Ternary Operators', [
    { op: 'math_clamp', args: { val: 10, min: 0, max: 5 }, expected: 5 },
    { op: 'math_clamp', args: { val: -10, min: 0, max: 5 }, expected: 0 },
    { op: 'math_clamp', args: { val: 3, min: 0, max: 5 }, expected: 3 },
    { op: 'math_mad', args: { a: 2, b: 3, c: 4 }, expected: 10 }, // 2*3 + 4
    { op: 'vec_mix', args: { a: [0, 0], b: [10, 10], t: 0.5 }, expected: [5, 5] },
  ]);

  runParametricTest('Color Operations', [
    // color_mix (Back, Front) -> Blended
    // Back: Red Opaque [1, 0, 0, 1]
    // Front: Green 50% [0, 1, 0, 0.5]
    // Result: [0.5, 0.5, 0, 1]
    {
      op: 'color_mix',
      args: { a: [1, 0, 0, 1], b: [0, 1, 0, 0.5] },
      expected: [0.5, 0.5, 0, 1]
    },
    // Back: transparent [0,0,0,0]
    // Front: Blue 50% [0, 0, 1, 0.5]
    // Result:
    // Alpha = 0.5 + 0 = 0.5
    // RGB = ( [0,0,1]*0.5 + 0 ) / 0.5 = [0, 0, 1]
    // Result: [0, 0, 1, 0.5]
    {
      op: 'color_mix',
      args: { a: [0, 0, 0, 0], b: [0, 0, 1, 0.5] },
      expected: [0, 0, 1, 0.5]
    }
  ]);

  runParametricTest('Constructors and Swizzles', [
    { op: 'float2', args: { x: 1, y: 2 }, expected: [1, 2] },
    { op: 'float3', args: { x: 1, y: 2, z: 3 }, expected: [1, 2, 3] },
    { op: 'float4', args: { x: 1, y: 2, z: 3, w: 4 }, expected: [1, 2, 3, 4] },
    { op: 'vec_swizzle', args: { vec: [1, 2, 3, 4], channels: 'x' }, expected: 1 },
    { op: 'vec_swizzle', args: { vec: [1, 2, 3, 4], channels: 'wzyx' }, expected: [4, 3, 2, 1] },
    { op: 'vec_swizzle', args: { vec: [1, 2], channels: 'yxy' }, expected: [2, 1, 2] },
    { op: 'vec_get_element', args: { vec: [10, 20, 30], index: 1 }, expected: 20 },
  ]);

  runParametricTest('Logic & Comparison', [
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
