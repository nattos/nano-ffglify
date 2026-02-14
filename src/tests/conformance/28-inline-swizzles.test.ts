import { describe, expect, it } from 'vitest';
import { runParametricTest, buildSimpleIR, availableBackends } from './test-runner';
import { validateStaticLogic } from '../../ir/validator';

const getResult = (ctx: any, varId: string) => {
  if (ctx.result !== undefined) return ctx.result;
  try { return ctx.getVar(varId); } catch { return undefined; }
};

describe('Conformance: Inline Swizzles', () => {
  describe('Single component', () => {
    runParametricTest('vec3_var.x -> float scalar', [
      { id: 'mk', op: 'float3', x: 1.0, y: 2.0, z: 3.0 },
      { id: 'store_v', op: 'var_set', var: 'v', val: 'mk' },
      // Use inline swizzle to extract x
      { id: 'get_x', op: 'literal', val: 0 },  // dummy to carry result
      { id: 'store', op: 'var_set', var: 'res', val: 'v.x' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBeCloseTo(1.0, 4);
    }, [], [], [{ id: 'v', type: 'float3' }, { id: 'res', type: 'float' }]);
  });

  describe('Multi-component', () => {
    runParametricTest('vec3_var.xy -> float2', [
      { id: 'mk', op: 'float3', x: 10.0, y: 20.0, z: 30.0 },
      { id: 'store_v', op: 'var_set', var: 'v', val: 'mk' },
      { id: 'store', op: 'var_set', var: 'res', val: 'v.xy' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(2);
      expect(v[0]).toBeCloseTo(10.0, 4);
      expect(v[1]).toBeCloseTo(20.0, 4);
    }, [], [], [{ id: 'v', type: 'float3' }, { id: 'res', type: 'float2' }]);
  });

  describe('Reorder swizzle', () => {
    runParametricTest('vec4_var.wzyx -> reversed float4', [
      { id: 'mk', op: 'float4', x: 1.0, y: 2.0, z: 3.0, w: 4.0 },
      { id: 'store_v', op: 'var_set', var: 'v', val: 'mk' },
      { id: 'swz', op: 'vec_swizzle', vec: 'v', channels: 'wzyx' },
      { id: 'store', op: 'var_set', var: 'res', val: 'swz' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(4);
      expect(v[0]).toBeCloseTo(4.0, 4);
      expect(v[1]).toBeCloseTo(3.0, 4);
      expect(v[2]).toBeCloseTo(2.0, 4);
      expect(v[3]).toBeCloseTo(1.0, 4);
    }, [], [], [{ id: 'v', type: 'float4' }, { id: 'res', type: 'float4' }]);
  });

  describe('Int vector swizzle', () => {
    runParametricTest('int3_var.xy -> int2', [
      { id: 'mk', op: 'int3', x: 100, y: 200, z: 300 },
      { id: 'store_v', op: 'var_set', var: 'v', val: 'mk' },
      { id: 'store', op: 'var_set', var: 'res', val: 'v.xy' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(2);
      expect(v[0]).toBe(100);
      expect(v[1]).toBe(200);
    }, [], [], [{ id: 'v', type: 'int3' }, { id: 'res', type: 'int2' }]);
  });

  describe('Swizzle from pure node ref', () => {
    runParametricTest('node_ref.yz -> float2 from float3 node', [
      { id: 'mk', op: 'float3', x: 5.0, y: 6.0, z: 7.0 },
      // Use inline swizzle directly on a node reference
      { id: 'store', op: 'var_set', var: 'res', val: 'mk.yz' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res') as number[];
      expect(v).toHaveLength(2);
      expect(v[0]).toBeCloseTo(6.0, 4);
      expect(v[1]).toBeCloseTo(7.0, 4);
    }, [], [], [{ id: 'res', type: 'float2' }]);
  });

  describe('Swizzle in arithmetic', () => {
    runParametricTest('math_add(vec.x, vec.z)', [
      { id: 'mk', op: 'float3', x: 10.0, y: 20.0, z: 30.0 },
      { id: 'store_v', op: 'var_set', var: 'v', val: 'mk' },
      { id: 'sum', op: 'math_add', a: 'v.x', b: 'v.z' },
      { id: 'store', op: 'var_set', var: 'res', val: 'sum' },
      { id: 'ret', op: 'func_return', val: 'res' },
    ], ctx => {
      const v = getResult(ctx, 'res');
      expect(v).toBeCloseTo(40.0, 4);
    }, [], [], [{ id: 'v', type: 'float3' }, { id: 'res', type: 'float' }]);
  });

  describe('Validation errors', () => {
    it('should reject node ID containing "."', () => {
      const ir = buildSimpleIR('dot-in-id', [
        { id: 'a.b', op: 'literal', val: 1 },
        { id: 'ret', op: 'func_return', val: 'a.b' },
      ]);
      const errors = validateStaticLogic(ir);
      expect(errors.some(e => e.message.includes("contains '.'"))).toBe(true);
    });

    it('should reject swizzle on scalar type', () => {
      const ir = buildSimpleIR('scalar-swizzle', [
        { id: 'lit', op: 'literal', val: 1.0 },
        { id: 'store', op: 'var_set', var: 'res', val: 'lit.x' },
        { id: 'ret', op: 'func_return' },
      ]);
      const errors = validateStaticLogic(ir);
      expect(errors.some(e => e.message.includes('Cannot swizzle non-vector'))).toBe(true);
    });

    it('should reject out-of-bounds swizzle', () => {
      const ir = buildSimpleIR('oob-swizzle', [
        { id: 'mk', op: 'float2', x: 1, y: 2 },
        { id: 'store', op: 'var_set', var: 'res', val: 'mk.z' },
        { id: 'ret', op: 'func_return' },
      ]);
      const errors = validateStaticLogic(ir);
      expect(errors.some(e => e.message.includes('out of bounds'))).toBe(true);
    });
  });
});
