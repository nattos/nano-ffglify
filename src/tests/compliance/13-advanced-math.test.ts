import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Advanced Math Ops', () => {

  const buildIR = (name: string, nodes: any[]): IRDocument => {
    // Boilerplate IR construction
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
      version: '1.0.0',
      meta: { name },
      entryPoint: 'main',
      inputs: [],
      resources: [],
      structs: [],
      functions: [{
        id: 'main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [{ id: 'res', type: 'any' }],
        nodes: nodes,
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
        if (typeof expectedVal === 'number') {
          expect(result).toBeCloseTo(expectedVal, 5);
        } else {
          expect(result).toEqual(expectedVal);
        }
      }
    });
  };

  // ----------------------------------------------------------------
  // Rounding: fract, trunc
  // ----------------------------------------------------------------
  runTest('fract(1.5)', [
    { id: 'op', op: 'math_fract', val: 1.5 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.5);

  runTest('fract(-1.2)', [
    // -1.2 - floor(-1.2) = -1.2 - (-2.0) = 0.8
    { id: 'op', op: 'math_fract', val: -1.2 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.8);

  runTest('trunc(-1.5)', [
    { id: 'op', op: 'math_trunc', val: -1.5 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', -1.0);

  // ----------------------------------------------------------------
  // Classification: is_nan, is_inf
  // ----------------------------------------------------------------
  runTest('is_nan(NaN)', [
    { id: 'nan', op: 'math_sqrt', val: -1.0 },
    { id: 'check', op: 'math_is_nan', val: 'nan' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'check' }
  ], 'res', true);

  runTest('is_inf(1/0)', [
    { id: 'inf', op: 'math_div', a: 1.0, b: 0.0 },
    { id: 'check', op: 'math_is_inf', val: 'inf' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'check' }
  ], 'res', true);

  runTest('is_finite(0)', [
    { id: 'check', op: 'math_is_finite', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'check' }
  ], 'res', true);

  // ----------------------------------------------------------------
  // Subnormal
  // ----------------------------------------------------------------
  runTest('flush_subnormal(1e-40)', [
    { id: 'op', op: 'math_flush_subnormal', val: 1.0e-40 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.0);

  runTest('flush_subnormal(1e-30)', [
    { id: 'op', op: 'math_flush_subnormal', val: 1.0e-30 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 1.0e-30);

  // ----------------------------------------------------------------
  // Frexp (Mantissa/Exponent)
  // ----------------------------------------------------------------
  // 3.0 = 0.75 * 2^2
  runTest('mantissa(3.0)', [
    { id: 'op', op: 'math_mantissa', val: 3.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.75);

  runTest('exponent(3.0)', [
    { id: 'op', op: 'math_exponent', val: 3.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 2.0);

  // 1.0 = 0.5 * 2^1
  runTest('mantissa(1.0)', [
    { id: 'op', op: 'math_mantissa', val: 1.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.5);

  runTest('exponent(1.0)', [
    { id: 'op', op: 'math_exponent', val: 1.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 1.0);

  // 0.0
  runTest('mantissa(0.0)', [
    { id: 'op', op: 'math_mantissa', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.0);

  runTest('exponent(0.0)', [
    { id: 'op', op: 'math_exponent', val: 0.0 },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', 0.0);

});
