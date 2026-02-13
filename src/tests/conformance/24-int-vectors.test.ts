import { describe, expect } from 'vitest';
import { runParametricTest, availableBackends } from './test-runner';

// Helper: get result from ctx.result (CPU/CppMetal) or ctx.getVar (GPU/Metal)
const getResult = (ctx: any, varId: string) => {
  if (ctx.result !== undefined) return ctx.result;
  try { return ctx.getVar(varId); } catch { return undefined; }
};

describe('Conformance: Int Vectors', () => {
  // ----------------------------------------------------------------
  // Constructors
  // ----------------------------------------------------------------
  describe('Constructors', () => {
    runParametricTest('int2(3, 5)', [
      { id: 'mk', op: 'int2', x: 3, y: 5 },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(2);
      expect(v[0]).toBe(3);
      expect(v[1]).toBe(5);
    }, [], [], [{ id: 'res', type: 'int2' }]);

    runParametricTest('int3(1, 2, 3)', [
      { id: 'mk', op: 'int3', x: 1, y: 2, z: 3 },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBe(1);
      expect(v[1]).toBe(2);
      expect(v[2]).toBe(3);
    }, [], [], [{ id: 'res', type: 'int3' }]);

    runParametricTest('int4(10, 20, 30, 40)', [
      { id: 'mk', op: 'int4', x: 10, y: 20, z: 30, w: 40 },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(4);
      expect(v[0]).toBe(10);
      expect(v[1]).toBe(20);
      expect(v[2]).toBe(30);
      expect(v[3]).toBe(40);
    }, [], [], [{ id: 'res', type: 'int4' }]);
  });

  // ----------------------------------------------------------------
  // Element Access
  // ----------------------------------------------------------------
  describe('Element Access', () => {
    runParametricTest('vec_get_element(int3, 1)', [
      { id: 'mk', op: 'int3', x: 10, y: 20, z: 30 },
      { id: 'get', op: 'vec_get_element', vec: 'mk', index: 1 },
      { id: 'store', op: 'var_set', var: 'res', val: 'get' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBe(20);
    }, [], [], [{ id: 'res', type: 'int' }]);
  });

  // ----------------------------------------------------------------
  // Casts
  // ----------------------------------------------------------------
  describe('Casts', () => {
    runParametricTest('static_cast_int3(float3(1.5, 2.7, 3.1))', [
      { id: 'fv', op: 'float3', x: 1.5, y: 2.7, z: 3.1 },
      { id: 'cast', op: 'static_cast_int3', val: 'fv' },
      { id: 'store', op: 'var_set', var: 'res', val: 'cast' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBe(1);
      expect(v[1]).toBe(2);
      expect(v[2]).toBe(3);
    }, [], [], [{ id: 'res', type: 'int3' }]);

    runParametricTest('static_cast_float3(int3(1, 2, 3))', [
      { id: 'iv', op: 'int3', x: 1, y: 2, z: 3 },
      { id: 'cast', op: 'static_cast_float3', val: 'iv' },
      { id: 'store', op: 'var_set', var: 'res', val: 'cast' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBeCloseTo(1.0, 5);
      expect(v[1]).toBeCloseTo(2.0, 5);
      expect(v[2]).toBeCloseTo(3.0, 5);
    }, [], [], [{ id: 'res', type: 'float3' }]);
  });

  // ----------------------------------------------------------------
  // Arithmetic
  // ----------------------------------------------------------------
  describe('Arithmetic', () => {
    runParametricTest('math_add(int3, int3)', [
      { id: 'a', op: 'int3', x: 1, y: 2, z: 3 },
      { id: 'b', op: 'int3', x: 4, y: 5, z: 6 },
      { id: 'sum', op: 'math_add', a: 'a', b: 'b' },
      { id: 'store', op: 'var_set', var: 'res', val: 'sum' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBe(5);
      expect(v[1]).toBe(7);
      expect(v[2]).toBe(9);
    }, [], [], [{ id: 'res', type: 'int3' }]);
  });
});
