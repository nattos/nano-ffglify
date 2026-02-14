import { describe, expect, it } from 'vitest';
import { runParametricTest, buildSimpleIR, availableBackends } from './test-runner';
import { validateStaticLogic } from '../../ir/validator';

const getResult = (ctx: any, varId: string) => {
  if (ctx.result !== undefined) return ctx.result;
  try { return ctx.getVar(varId); } catch { return undefined; }
};

describe('Conformance: Flexible Vector Constructors', () => {
  describe('float3 with xy + z', () => {
    runParametricTest('float3(xy: vec2_ref, z: 1.0)', [
      { id: 'v2', op: 'float2', x: 10.0, y: 20.0 },
      { id: 'mk', op: 'float3', xy: 'v2', z: 1.0 },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBeCloseTo(10.0, 4);
      expect(v[1]).toBeCloseTo(20.0, 4);
      expect(v[2]).toBeCloseTo(1.0, 4);
    }, [], [], [{ id: 'res', type: 'float3' }]);
  });

  describe('float3 with x + yz', () => {
    runParametricTest('float3(x: 1.0, yz: vec2_ref)', [
      { id: 'v2', op: 'float2', x: 5.0, y: 6.0 },
      { id: 'mk', op: 'float3', x: 1.0, yz: 'v2' },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBeCloseTo(1.0, 4);
      expect(v[1]).toBeCloseTo(5.0, 4);
      expect(v[2]).toBeCloseTo(6.0, 4);
    }, [], [], [{ id: 'res', type: 'float3' }]);
  });

  describe('float4 with xy + zw', () => {
    runParametricTest('float4(xy: v1, zw: v2)', [
      { id: 'v1', op: 'float2', x: 1.0, y: 2.0 },
      { id: 'v2', op: 'float2', x: 3.0, y: 4.0 },
      { id: 'mk', op: 'float4', xy: 'v1', zw: 'v2' },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(4);
      expect(v[0]).toBeCloseTo(1.0, 4);
      expect(v[1]).toBeCloseTo(2.0, 4);
      expect(v[2]).toBeCloseTo(3.0, 4);
      expect(v[3]).toBeCloseTo(4.0, 4);
    }, [], [], [{ id: 'res', type: 'float4' }]);
  });

  describe('float4 with xyz + w', () => {
    runParametricTest('float4(xyz: v3, w: 1.0)', [
      { id: 'v3', op: 'float3', x: 10.0, y: 20.0, z: 30.0 },
      { id: 'mk', op: 'float4', xyz: 'v3', w: 1.0 },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(4);
      expect(v[0]).toBeCloseTo(10.0, 4);
      expect(v[1]).toBeCloseTo(20.0, 4);
      expect(v[2]).toBeCloseTo(30.0, 4);
      expect(v[3]).toBeCloseTo(1.0, 4);
    }, [], [], [{ id: 'res', type: 'float4' }]);
  });

  describe('Broadcast scalar to multi-component', () => {
    runParametricTest('float3(xyz: 5.0) -> broadcast [5, 5, 5]', [
      { id: 'mk', op: 'float3', xyz: 5.0 },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBeCloseTo(5.0, 4);
      expect(v[1]).toBeCloseTo(5.0, 4);
      expect(v[2]).toBeCloseTo(5.0, 4);
    }, [], [], [{ id: 'res', type: 'float3' }]);
  });

  describe('Int types', () => {
    runParametricTest('int3(xy: int2_ref, z: 3)', [
      { id: 'v2', op: 'int2', x: 10, y: 20 },
      { id: 'mk', op: 'int3', xy: 'v2', z: 3 },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBe(10);
      expect(v[1]).toBe(20);
      expect(v[2]).toBe(3);
    }, [], [], [{ id: 'res', type: 'int3' }]);
  });

  describe('Backward compatibility', () => {
    runParametricTest('float3(x: 1, y: 2, z: 3) -> still works', [
      { id: 'mk', op: 'float3', x: 1.0, y: 2.0, z: 3.0 },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBeCloseTo(1.0, 4);
      expect(v[1]).toBeCloseTo(2.0, 4);
      expect(v[2]).toBeCloseTo(3.0, 4);
    }, [], [], [{ id: 'res', type: 'float3' }]);
  });

  describe('Composes with inline swizzles', () => {
    runParametricTest('float3(xy: color.rg, z: 1.0)', [
      { id: 'color', op: 'float4', x: 0.2, y: 0.4, z: 0.6, w: 1.0 },
      { id: 'store_c', op: 'var_set', var: 'c', val: 'color' },
      { id: 'mk', op: 'float3', xy: 'c.xy', z: 1.0 },
      { id: 'store', op: 'var_set', var: 'res', val: 'mk' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(3);
      expect(v[0]).toBeCloseTo(0.2, 4);
      expect(v[1]).toBeCloseTo(0.4, 4);
      expect(v[2]).toBeCloseTo(1.0, 4);
    }, [], [], [{ id: 'c', type: 'float4' }, { id: 'res', type: 'float3' }]);
  });

  describe('Validation errors', () => {
    it('should reject gap in component groups', () => {
      const ir = buildSimpleIR('gap-components', [
        { id: 'mk', op: 'float3', x: 1, z: 3 },
        { id: 'ret', op: 'func_return' },
      ]);
      const errors = validateStaticLogic(ir);
      // Should have error about missing component y or gap
      const hasError = errors.some(e => e.message.includes('gap') || e.message.includes('cover'));
      expect(hasError).toBe(true);
    });

    it('should reject overlapping component groups', () => {
      const ir = buildSimpleIR('overlap-components', [
        { id: 'mk', op: 'float3', xy: 1, yz: 2 },
        { id: 'ret', op: 'func_return' },
      ]);
      const errors = validateStaticLogic(ir);
      const hasError = errors.some(e => e.message.includes('gap') || e.message.includes('overlap') || e.message.includes('cover'));
      expect(hasError).toBe(true);
    });
  });
});
