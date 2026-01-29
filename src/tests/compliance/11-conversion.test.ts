import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';
import { validateIR } from '../../ir/schema';

describe('Compliance: Type Conversion', () => {

  const buildIR = (name: string, nodes: any[]): IRDocument => {
    // Auto-wire edges logic
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
      structs: [],
      resources: [],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [{ id: 'res', type: 'float' }], // Default var for tests
        nodes: nodes.map((n, i) => ({ ...n, id: n.id || `node_${i}` })),
        edges: edges
      }]
    };
  };

  const runTest = (name: string, nodes: any[], varToCheck: string, expectedVal: any) => {
    it(name, () => {
      const ir = buildIR(name, nodes);

      // Static Validation First
      const validation = validateIR(ir);
      if (!validation.success) {
        console.error(validation.errors);
      }
      expect(validation.success).toBe(true);

      const ctx = new EvaluationContext(ir, new Map());
      const exec = new CpuExecutor(ctx);

      // Manually execute to keep frame alive for inspection
      ctx.pushFrame('test_main');
      const func = ir.functions[0];

      // Init locals if any (though executeFunction does this too?)
      // CpuExecutor.executeFunction() does init locals.

      exec.executeFunction(func);

      const result = ctx.getVar(varToCheck);
      expect(result).toEqual(expectedVal);
    });
  };

  // ----------------------------------------------------------------
  // Float -> Int
  // ----------------------------------------------------------------
  runTest('Cast Float to Int (Truncation)', [
    { id: 'f1', op: 'math_add', a: 1.5, b: 0.1 }, // 1.6
    { id: 'i1', op: 'static_cast_int', val: 'f1' }, // 1
    { id: 'sink', op: 'var_set', var: 'res', val: 'i1' }
  ], 'res', 1);

  runTest('Cast Negative Float to Int (Truncation)', [
    { id: 'f1', op: 'math_add', a: -1.9, b: 0.0 }, // -1.9
    { id: 'i1', op: 'static_cast_int', val: 'f1' }, // -1
    { id: 'sink', op: 'var_set', var: 'res', val: 'i1' }
  ], 'res', -1);

  // ----------------------------------------------------------------
  // Bool -> Int
  // ----------------------------------------------------------------
  runTest('Cast Bool True to Int', [
    { id: 'b1', op: 'math_gt', a: 10, b: 5 }, // true
    { id: 'i1', op: 'static_cast_int', val: 'b1' }, // 1
    { id: 'sink', op: 'var_set', var: 'res', val: 'i1' }
  ], 'res', 1);

  runTest('Cast Bool False to Int', [
    { id: 'b1', op: 'math_gt', a: 5, b: 10 }, // false
    { id: 'i1', op: 'static_cast_int', val: 'b1' }, // 0
    { id: 'sink', op: 'var_set', var: 'res', val: 'i1' }
  ], 'res', 0);

  // ----------------------------------------------------------------
  // Int -> Float
  // ----------------------------------------------------------------
  runTest('Cast Int to Float', [
    { id: 'i1', op: 'static_cast_int', val: 5 }, // 5 (from number literal 5 which is float, cast to int first?)
    // Actually literal 5 is number. 'static_cast_int' takes number. Output int.
    // Then we cast back to float.
    { id: 'f1', op: 'static_cast_float', val: 'i1' }, // 5.0
    { id: 'sink', op: 'var_set', var: 'res', val: 'f1' }
  ], 'res', 5);

  // ----------------------------------------------------------------
  // Bool -> Float
  // ----------------------------------------------------------------
  runTest('Cast Bool True to Float', [
    { id: 'b1', op: 'math_eq', a: 1, b: 1 }, // true
    { id: 'f1', op: 'static_cast_float', val: 'b1' }, // 1.0
    { id: 'sink', op: 'var_set', var: 'res', val: 'f1' }
  ], 'res', 1.0);

  runTest('Cast Bool False to Float', [
    { id: 'b1', op: 'math_eq', a: 1, b: 2 }, // false
    { id: 'f1', op: 'static_cast_float', val: 'b1' }, // 0.0
    { id: 'sink', op: 'var_set', var: 'res', val: 'f1' }
  ], 'res', 0.0);

  // ----------------------------------------------------------------
  // Int -> Bool
  // ----------------------------------------------------------------
  runTest('Cast Int Non-Zero to Bool', [
    { id: 'i1', op: 'static_cast_int', val: 5 },
    { id: 'b1', op: 'static_cast_bool', val: 'i1' }, // true
    { id: 'sink', op: 'var_set', var: 'res', val: 'b1' }
  ], 'res', true);

  runTest('Cast Int Zero to Bool', [
    { id: 'i1', op: 'static_cast_int', val: 0 },
    { id: 'b1', op: 'static_cast_bool', val: 'i1' }, // false
    { id: 'sink', op: 'var_set', var: 'res', val: 'b1' }
  ], 'res', false);

  // ----------------------------------------------------------------
  // Float -> Bool
  // ----------------------------------------------------------------
  runTest('Cast Float Non-Zero to Bool', [
    { id: 'b1', op: 'static_cast_bool', val: 0.1 }, // true
    { id: 'sink', op: 'var_set', var: 'res', val: 'b1' }
  ], 'res', true);

  runTest('Cast Float Zero to Bool', [
    { id: 'b1', op: 'static_cast_bool', val: 0.0 }, // false
    { id: 'sink', op: 'var_set', var: 'res', val: 'b1' }
  ], 'res', false);

});
