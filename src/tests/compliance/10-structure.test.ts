import { describe, it, expect } from 'vitest';
import { validateIR } from '../../ir/schema';
import { IRDocument } from '../../ir/types';

describe('Compliance: Structural Logic Validation', () => {

  const makeIR = (nodes: any[], structs: any[] = []): IRDocument => ({
    version: '3.0.0',
    meta: { name: 'Structure Test' },
    entryPoint: 'fn_main',
    inputs: [],
    resources: [],
    structs: structs,
    functions: [{
      id: 'fn_main',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      edges: [],
      nodes: nodes
    }]
  });

  describe('Vector Swizzling', () => {
    it('should validate correct swizzles', () => {
      const ir = makeIR([
        { id: 'v2', op: 'vec2', x: 1, y: 2 },
        { id: 'swiz', op: 'vec_swizzle', val: 'v2', mask: 'yx' },
        { id: 'swiz_scalar', op: 'vec_swizzle', val: 'v2', mask: 'x' }
      ]);
      const result = validateIR(ir);
      expect(result.success).toBe(true);
    });

    it('should fail on invalid mask length', () => {
      const ir = makeIR([
        { id: 'v2', op: 'vec2', x: 1, y: 2 },
        { id: 'swiz', op: 'vec_swizzle', val: 'v2', mask: 'xyzzz' } // 5 chars
      ]);
      const result = validateIR(ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].message).toContain('Invalid swizzle mask length');
      }
    });

    it('should fail on invalid mask characters', () => {
      const ir = makeIR([
        { id: 'v2', op: 'vec2', x: 1, y: 2 },
        { id: 'swiz', op: 'vec_swizzle', val: 'v2', mask: 'xq' } // 'q' is invalid
      ]);
      const result = validateIR(ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].message).toContain("Invalid swizzle component 'q'");
      }
    });

    it('should fail on out-of-bounds component access', () => {
      const ir = makeIR([
        { id: 'v2', op: 'vec2', x: 1, y: 2 },
        // 'z' is index 2, vec2 has size 2 (indices 0,1)
        { id: 'swiz', op: 'vec_swizzle', val: 'v2', mask: 'xz' }
      ]);
      const result = validateIR(ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].message).toContain("Swizzle component 'z' out of bounds for vec2");
      }
    });
  });

  describe('Constructor Arity', () => {
    it('should fail on extra/unknown arguments', () => {
      const ir = makeIR([
        // vec2 takes x, y. 'z' is extra.
        { id: 'v2', op: 'vec2', x: 1, y: 2, z: 3 }
      ]);
      const result = validateIR(ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].message).toContain("Unknown argument(s) 'z'");
      }
    });

    it('should fail on missing arguments', () => {
      const ir = makeIR([
        { id: 'v2', op: 'vec2', x: 1 } // missing y
      ]);
      const result = validateIR(ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].message).toContain("Missing required argument 'y'");
      }
    });
  });

  describe('Recursive Structs', () => {
    it('should detect direct recursion', () => {
      const ir = makeIR([], [
        {
          id: 'Node',
          members: [
            { name: 'val', type: 'float' },
            { name: 'next', type: 'Node' } // Recursive
          ]
        }
      ]);
      const result = validateIR(ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].message).toContain("Recursive struct definition detected");
        expect(result.errors[0].message).toContain("Node");
      }
    });

    it('should detect indirect recursion (cycle)', () => {
      const ir = makeIR([], [
        {
          id: 'A',
          members: [{ name: 'b', type: 'B' }]
        },
        {
          id: 'B',
          members: [{ name: 'a', type: 'A' }]
        }
      ]);
      const result = validateIR(ir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].message).toContain("Recursive struct definition detected");
      }
    });

    it('should allow non-recursive references', () => {
      const ir = makeIR([], [
        {
          id: 'Leaf',
          members: [{ name: 'val', type: 'float' }]
        },
        {
          id: 'Tree',
          members: [{ name: 'leaf', type: 'Leaf' }]
        }
      ]);
      const result = validateIR(ir);
      expect(result.success).toBe(true);
    });
  });

});
