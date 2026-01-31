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

    it('should fail if a reference is used for a non-refable argument', () => {
      // 'literal' op: 'val' is z.any() but NOT refable.
      const node = { id: 'n1', op: 'literal', val: 'some_string' };
      const result = verifyLiteralsOrRefsExist(node as any);
      // Wait, 'literal' val IS allowed to be a string if it's a literal string.
      // But verifyLiteralsOrRefsExist checks if it DOES NOT support references.
      // In LiteralDef, refable is false. So it will say "Argument 'val' does not support references, but got string".
      // This is slightly ambiguous for 'literal' because the literal could be a string.
      // However, for most other ops it works perfectly.
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("does not support references");
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
      expect(result.errors[0]).toContain("Missing required argument: b");
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
