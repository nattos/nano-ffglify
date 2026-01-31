import { describe, it, expect } from 'vitest';
import { verifyLiteralsOrRefsExist, isArgumentAReference } from './schema-verifier';

describe('Schema Verifier', () => {
  describe('verifyLiteralsOrRefsExist', () => {
    it('should allow literals for refable arguments', () => {
      const node = { id: 'n1', op: 'math_add', a: 5, b: 10 };
      const result = verifyLiteralsOrRefsExist(node as any);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should allow references for refable arguments', () => {
      const node = { id: 'n1', op: 'math_add', a: 'var1', b: 'var2' };
      const result = verifyLiteralsOrRefsExist(node as any);
      expect(result.valid).toBe(true);
    });

    it('should fail if a string is provided for a non-string-literal argument with no ref support', () => {
      // We'll define a temporary mock op or use a known one.
      // Float2 x is refable: true, so it allows strings as refs.
      // Let's use an hypothetical op that doesn't allow either.
      // Actually, we can just check math_add with a literal that isn't allowed.
      const invalidNode = { id: 'n1', op: 'math_add', a: { some: 'object' }, b: 5 };
      const result = verifyLiteralsOrRefsExist(invalidNode as any);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("has invalid literal type");
    });

    it('should require references for requiredRef arguments', () => {
      // 'texture_sample' tex is requiredRef: true
      const node = { id: 'n1', op: 'texture_sample', tex: 'my_tex', coords: [0.5, 0.5] };
      const result = verifyLiteralsOrRefsExist(node as any);
      expect(result.valid).toBe(true);

      const invalidNode = { id: 'n1', op: 'texture_sample', tex: 123, coords: [0.5, 0.5] };
      const invalidResult = verifyLiteralsOrRefsExist(invalidNode as any);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors[0]).toContain("must be a reference (string)");
    });

    it('should handle optional arguments correctly', () => {
      // 'flow_loop' count is optional
      const node = { id: 'n1', op: 'flow_loop', start: 0, end: 10 };
      const result = verifyLiteralsOrRefsExist(node as any);
      expect(result.valid).toBe(true);

      const nodeWithCount = { id: 'n1', op: 'flow_loop', count: 'my_count' };
      const resultWithCount = verifyLiteralsOrRefsExist(nodeWithCount as any);
      expect(resultWithCount.valid).toBe(true);
    });

    it('should fail on missing required arguments', () => {
      const node = { id: 'n1', op: 'math_add', a: 5 }; // Missing 'b'
      const result = verifyLiteralsOrRefsExist(node as any);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Missing required argument 'b'");
    });

    it('should verify reference existence when IR context is provided', () => {
      const ir = {
        resources: [{ id: 'tex1' }],
        inputs: [{ id: 'u_val' }]
      };
      const func = {
        localVars: [{ id: 'v_local' }],
        nodes: [{ id: 'node1', op: 'math_add' }]
      };

      // Valid references
      const node1 = { id: 'n2', op: 'math_add', a: 'u_val', b: 'v_local' };
      expect(verifyLiteralsOrRefsExist(node1 as any, ir, func).valid).toBe(true);

      const node2 = { id: 'n3', op: 'texture_sample', tex: 'tex1', coords: [0, 0] };
      expect(verifyLiteralsOrRefsExist(node2 as any, ir, func).valid).toBe(true);

      // Invalid reference
      const invalidNode = { id: 'n4', op: 'math_add', a: 'unknown_id', b: 5 };
      const result = verifyLiteralsOrRefsExist(invalidNode as any, ir, func);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("references unknown ID 'unknown_id'");
    });

    it('should validate literal types when literalTypes is provided', () => {
      // math_add expects float/int/float2/3/4.
      // If we pass a boolean literal, it should fail.
      const invalidNode = { id: 'n1', op: 'math_add', a: true, b: 5 };
      const result = verifyLiteralsOrRefsExist(invalidNode as any);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("invalid literal type: expected one of [float, int, float2, float3, float4], but got bool");

      const validNode = { id: 'n2', op: 'math_add', a: 5.5, b: [1, 2] };
      expect(verifyLiteralsOrRefsExist(validNode as any).valid).toBe(true);
    });
  });

  describe('isArgumentAReference', () => {
    it('should correctly identify references', () => {
      expect(isArgumentAReference('math_add', 'a', 'my_var')).toBe(true);
      expect(isArgumentAReference('math_add', 'a', 5)).toBe(false);

      expect(isArgumentAReference('texture_sample', 'tex', 'my_tex')).toBe(true);
      expect(isArgumentAReference('texture_sample', 'tex', 123)).toBe(false);

      expect(isArgumentAReference('literal', 'val', 'any_string')).toBe(false);
    });
  });
});
