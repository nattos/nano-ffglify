import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Runtime Edge Cases', () => {

  const buildIR = (name: string, nodes: any[]): IRDocument => {
    // Shared Auto-wire logic
    const edges: any[] = [];
    const nodeIds = new Set(nodes.map(n => n.id));
    nodes.forEach(node => {
      Object.keys(node).forEach(key => {
        const val = node[key];
        if (typeof val === 'string' && nodeIds.has(val) && val !== node.id) {
          edges.push({ from: val, portOut: 'val', to: node.id, portIn: key, type: 'data' });
        }
      });
    });

    return {
      version: '3.0.0',
      meta: { name },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [],
      structs: [],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [{ id: 'res', type: 'float' }],
        nodes: nodes.map((n, i) => ({ ...n, id: n.id || `node_${i}` })),
        edges: edges
      }]
    };
  };

  const runTest = (name: string, nodes: any[], varToCheck: string, expectedVal: any) => {
    it(name, () => {
      const ir = buildIR(name, nodes);
      const ctx = new EvaluationContext(ir, new Map());
      const exec = new CpuExecutor(ctx);

      // Manually execute to keep frame alive for inspection
      ctx.pushFrame('test_main');
      const func = ir.functions[0];
      exec.executeFunction(func);

      const result = ctx.getVar(varToCheck);

      if (Number.isNaN(expectedVal)) {
        expect(result).toBeNaN();
      } else {
        expect(result).toEqual(expectedVal);
      }
    });
  };

  const runErrorTest = (name: string, nodes: any[], expectedError: string) => {
    it(name, () => {
      const ir = buildIR(name, nodes);
      const ctx = new EvaluationContext(ir, new Map());
      const exec = new CpuExecutor(ctx);
      expect(() => exec.executeEntry()).toThrow(expectedError);
    });
  };

  // ----------------------------------------------------------------
  // Math Limits
  // ----------------------------------------------------------------
  runTest('Div by Zero (CPU)', [
    { id: 'op', op: 'math_div', a: 1.0, b: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', Infinity);

  runTest('Sqrt Negative', [
    { id: 'op', op: 'math_sqrt', val: -1.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', NaN);

  runTest('Log Zero', [
    { id: 'op', op: 'math_log', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', -Infinity);

  // ----------------------------------------------------------------
  // Matrix Degradation
  // ----------------------------------------------------------------
  // Current implementation returns input for inverse if singular (placeholder behavior)
  // or maybe it doesn't check?
  // Let's verify what it does.
  // Singular matrix: all zeros. Inverse is ...?
  // Ops implementation: "return args.val" (Identity/Pass-through placeholder)
  runTest('Inverse Singular Matrix (Fallback)', [
    { id: 'm', op: 'mat_identity', size: 4 }, // is Identity singular? No.
    // Let's construct a singular matrix (all zeros)
    // mat_identity creates diagonal 1s
    // array_construct or manual?
    // We don't have mat_from_array readily available as a single op except 'mat4' constructor
    // which takes 'vals' array.
    { id: 'zeros', op: 'array_construct', length: 16, fill: 0 },
    { id: 'bad_mat', op: 'mat4', vals: 'zeros' },
    { id: 'inv', op: 'mat_inverse', val: 'bad_mat' },
    // If fallback is 'return val', it returns zeros.
    // If fallback is Identity, it returns Identity.
    // ops.ts says: "return args.val;"
    { id: 'extract', op: 'vec_get_element', vec: 'inv', index: 0 }, // first element
    { id: 'sink', op: 'var_set', var: 'res', val: 'extract' } // Should be 0
  ], 'res', 0);

  // ----------------------------------------------------------------
  // Recursion Limit (Runtime)
  // ----------------------------------------------------------------
  runErrorTest('Runtime Recursion Detection', [
    { id: 'call', op: 'call_func', func: 'fn_main' }, // Calls itself
    { id: 'sink', op: 'var_set', var: 'res', val: 'call' }
  ], 'Recursion detected');

});
