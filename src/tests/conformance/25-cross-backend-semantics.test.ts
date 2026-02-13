/**
 * @vitest-environment node
 *
 * Cross-backend semantic alignment tests.
 * These tests target specific divergences between CPU JIT, WGSL, MSL, and C++
 * that cause silently wrong results if not handled correctly.
 */
import { describe, expect } from 'vitest';
import { runParametricTest, runGraphTest, availableBackends } from './test-runner';

const getResult = (ctx: any, varId: string) => {
  if (ctx.result !== undefined) return ctx.result;
  try { return ctx.getVar(varId); } catch { return undefined; }
};

describe('Conformance: Cross-Backend Semantics', () => {

  // ----------------------------------------------------------------
  // Integer Division Truncation
  // ----------------------------------------------------------------
  describe('Integer Division', () => {
    // int / int should truncate toward zero (not produce float)
    runParametricTest('int div truncates: 7/2 = 3', [
      { id: 'a', op: 'int', val: 7 },
      { id: 'b', op: 'int', val: 2 },
      { id: 'div', op: 'math_div', a: 'a', b: 'b' },
      { id: 'store', op: 'var_set', var: 'res', val: 'div' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBe(3);
    }, [], [], [{ id: 'res', type: 'int' }]);

    // Negative int division truncates toward zero
    runParametricTest('int div truncates toward zero: -7/2 = -3', [
      { id: 'a', op: 'int', val: -7 },
      { id: 'b', op: 'int', val: 2 },
      { id: 'div', op: 'math_div', a: 'a', b: 'b' },
      { id: 'store', op: 'var_set', var: 'res', val: 'div' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBe(-3);
    }, [], [], [{ id: 'res', type: 'int' }]);

    // float / float should remain precise
    runGraphTest('float div is precise: 7.0/2.0 = 3.5', [
      { id: 'a', op: 'float', val: 7 },
      { id: 'b', op: 'float', val: 2 },
      { id: 'div', op: 'math_div', a: 'a', b: 'b' },
      { id: 'set_res', op: 'var_set', var: 'res', val: 'div' },
    ], 'res', 3.5);
  });

  // ----------------------------------------------------------------
  // loop_index Type
  // ----------------------------------------------------------------
  describe('loop_index type', () => {
    const bufferDef = {
      id: 'b_result',
      type: 'buffer',
      dataType: 'float',
      size: { mode: 'fixed', value: 1 },
      persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false },
    };

    // loop_index should be int, not float — verify via integer arithmetic
    // Accumulate last iteration: idx=4, 4+4=8
    runParametricTest('loop_index is int type', [
      { id: 'loop', op: 'flow_loop', start: 0, end: 5 },
      { id: 'idx', op: 'loop_index', loop: 'loop' },
      { id: 'doubled', op: 'math_add', a: 'idx', b: 'idx' },
      { id: 'update', op: 'var_set', var: 'res', val: 'doubled' },
      { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'res' },
    ], ctx => {
      const res = ctx.getResource('b_result');
      expect(res.data?.[0]).toBe(8);
    }, [bufferDef], [
      { from: 'loop', portOut: 'exec_body', to: 'update', portIn: 'exec_in', type: 'execution' },
      { from: 'loop', portOut: 'exec_completed', to: 'store', portIn: 'exec_in', type: 'execution' },
    ], [{ id: 'res', type: 'int', initialValue: 0 }]);
  });

  // ----------------------------------------------------------------
  // vec_swizzle on int vectors
  // ----------------------------------------------------------------
  describe('vec_swizzle int vectors', () => {
    runParametricTest('vec_swizzle int3.yz', [
      { id: 'v', op: 'int3', x: 10, y: 20, z: 30 },
      { id: 'sw', op: 'vec_swizzle', vec: 'v', channels: 'yz' },
      { id: 'store', op: 'var_set', var: 'res', val: 'sw' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(2);
      expect(v[0]).toBe(20);
      expect(v[1]).toBe(30);
    }, [], [], [{ id: 'res', type: 'int2' }]);

    runParametricTest('vec_swizzle int4.xw', [
      { id: 'v', op: 'int4', x: 100, y: 200, z: 300, w: 400 },
      { id: 'sw', op: 'vec_swizzle', vec: 'v', channels: 'xw' },
      { id: 'store', op: 'var_set', var: 'res', val: 'sw' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(2);
      expect(v[0]).toBe(100);
      expect(v[1]).toBe(400);
    }, [], [], [{ id: 'res', type: 'int2' }]);
  });

  // ----------------------------------------------------------------
  // Uninitialized Local Variable Zero-Init
  // ----------------------------------------------------------------
  describe('Zero-initialized local vars', () => {
    // Uninitialized float var should be 0
    runGraphTest('uninitialized float var is zero', [
      { id: 'get', op: 'var_get', var: 'res' },
      { id: 'set_res', op: 'var_set', var: 'res', val: 'get' },
    ], 'res', 0);

    // Uninitialized int var should be 0
    runParametricTest('uninitialized int var is zero', [
      { id: 'get', op: 'var_get', var: 'res' },
      { id: 'store', op: 'var_set', var: 'res', val: 'get' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBe(0);
    }, [], [], [{ id: 'res', type: 'int' }]);

    // Uninitialized float3 var should be [0,0,0]
    runParametricTest('uninitialized float3 var is zero', [
      { id: 'get', op: 'var_get', var: 'res' },
      { id: 'store', op: 'var_set', var: 'res', val: 'get' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBeCloseTo(0, 5);
      expect(v[1]).toBeCloseTo(0, 5);
      expect(v[2]).toBeCloseTo(0, 5);
    }, [], [], [{ id: 'res', type: 'float3' }]);
  });

});
