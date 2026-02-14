import { describe, expect } from 'vitest';
import { runParametricTest, runGraphTest, availableBackends, cpuBackends } from './test-runner';
import { validateStaticLogic } from '../../ir/validator';
import { buildSimpleIR } from './test-runner';

const getResult = (ctx: any, varId: string) => {
  if (ctx.result !== undefined) return ctx.result;
  try { return ctx.getVar(varId); } catch { return undefined; }
};

describe('Conformance: Typed Literals', () => {
  describe('Basic typed literals', () => {
    runParametricTest('int literal: { val: 42, type: "int" }', [
      { id: 'lit', op: 'literal', val: 42, type: 'int' },
      { id: 'store', op: 'var_set', var: 'res', val: 'lit' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBe(42);
    }, [], [], [{ id: 'res', type: 'int' }]);

    runParametricTest('float literal (default, no type)', [
      { id: 'lit', op: 'literal', val: 3.14 },
      { id: 'store', op: 'var_set', var: 'res', val: 'lit' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBeCloseTo(3.14, 4);
    });

    runParametricTest('bool literal: { val: true, type: "bool" }', [
      { id: 'lit', op: 'literal', val: true, type: 'bool' },
      { id: 'store', op: 'var_set', var: 'res', val: 'lit' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBeTruthy();
    }, [], [], [{ id: 'res', type: 'bool' }]);

    runParametricTest('explicit float literal: { val: 2.5, type: "float" }', [
      { id: 'lit', op: 'literal', val: 2.5, type: 'float' },
      { id: 'store', op: 'var_set', var: 'res', val: 'lit' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBeCloseTo(2.5, 4);
    });
  });

  describe('Int literals in arithmetic', () => {
    runParametricTest('math_add of two typed int literals', [
      { id: 'a', op: 'literal', val: 10, type: 'int' },
      { id: 'b', op: 'literal', val: 20, type: 'int' },
      { id: 'sum', op: 'math_add', a: 'a', b: 'b' },
      { id: 'store', op: 'var_set', var: 'res', val: 'sum' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBe(30);
    }, [], [], [{ id: 'res', type: 'int' }]);
  });

  describe('Validation', () => {
    it('should report error for invalid explicit type', () => {
      const ir = buildSimpleIR('invalid-literal-type', [
        { id: 'lit', op: 'literal', val: 42, type: 'texture2d' },
        { id: 'ret', op: 'func_return', val: 'lit' },
      ]);
      const errors = validateStaticLogic(ir);
      expect(errors.some(e => e.message.includes("Invalid explicit type 'texture2d'"))).toBe(true);
    });

    it('should validate typed literal produces correct type in validator', () => {
      const ir = buildSimpleIR('typed-int-validation', [
        { id: 'lit', op: 'literal', val: 7, type: 'int' },
        { id: 'store', op: 'var_set', var: 'res', val: 'lit' },
        { id: 'ret', op: 'func_return', val: 'res' },
      ], [], [], [{ id: 'res', type: 'int' }]);
      const errors = validateStaticLogic(ir);
      // Should not have type mismatch errors
      const typeErrors = errors.filter(e => e.message.includes('Type Mismatch'));
      expect(typeErrors).toHaveLength(0);
    });
  });
});
