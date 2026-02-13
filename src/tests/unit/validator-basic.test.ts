import { describe, it, expect } from 'vitest';
import { validateIR, inferFunctionTypes, analyzeFunction } from '../../ir/validator';
import { IRDocument } from '../../ir/types';
import { BUILTIN_TYPES, BUILTIN_CPU_ALLOWED } from '../../ir/builtin-schemas';

describe('Validator Basic Checks', () => {

  const createIR = (type: 'cpu' | 'shader', nodes: any[]): IRDocument => ({
    version: '3.0',
    meta: { name: 'test' },
    entryPoint: 'main',
    functions: [{
      id: 'main',
      type,
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        ...nodes,
        { id: 'ret', op: 'func_return' }
      ]
    }],
    resources: [],
    inputs: []
  });

  describe('Function Analysis', () => {
    it('should track used built-ins', () => {
      const ir = createIR('shader', [
        { id: 'b1', op: 'builtin_get', name: 'time' },
        { id: 'b2', op: 'builtin_get', name: 'delta_time' },
        { id: 'v1', op: 'literal', val: 1.0 }
      ]);
      const analysis = analyzeFunction(ir.functions[0], ir);
      expect(analysis.usedBuiltins).toContain('time');
      expect(analysis.usedBuiltins).toContain('delta_time');
      expect(analysis.usedBuiltins.size).toBe(2);
    });
  });

  describe('Built-in Availability & Types', () => {
    // Test ALL built-ins defined in BUILTIN_TYPES
    Object.entries(BUILTIN_TYPES).forEach(([name, expectedType]) => {
      const isCpuAllowed = BUILTIN_CPU_ALLOWED.includes(name);

      describe(`Built-in: ${name}`, () => {
        it(`should have correct type: ${expectedType}`, () => {
          const ir = createIR('shader', [
            { id: 'b', op: 'builtin_get', name }
          ]);
          const types = inferFunctionTypes(ir.functions[0], ir);
          expect(types.get('b'), `Type mismatch for ${name}`).toBe(expectedType);
        });

        if (isCpuAllowed) {
          it('should PASS on CPU', () => {
            const ir = createIR('cpu', [
              { id: 'b', op: 'builtin_get', name }
            ]);
            const errors = validateIR(ir);
            expect(errors, `Should be allowed on CPU: ${name}`).toHaveLength(0);
          });
        } else {
          it('should FAIL on CPU', () => {
            const ir = createIR('cpu', [
              { id: 'b', op: 'builtin_get', name }
            ]);
            const errors = validateIR(ir);
            expect(errors.length, `Should NOT be allowed on CPU: ${name}`).toBeGreaterThan(0);
            expect(errors[0].message).toMatch(/not available in CPU context/);
          });
        }

        it('should PASS on GPU', () => {
          const ir = createIR('shader', [
            { id: 'b', op: 'builtin_get', name }
          ]);
          const errors = validateIR(ir);
          expect(errors, `Should be allowed on GPU: ${name}`).toHaveLength(0);
        });
      });
    });

    it('should correctly infer float type for new built-ins and allow usage', () => {
      const ir = createIR('cpu', [
        { id: 'b1', op: 'builtin_get', name: 'time' },
        { id: 's1', op: 'literal', val: 1.0 },
        { id: 'add', op: 'math_add', a: 'b1', b: 's1' }
      ]);
      const errors = validateIR(ir);
      expect(errors).toHaveLength(0);
    });

    it('should correctly infer type when an operation uses a local variable', () => {
      const ir: IRDocument = {
        version: '3.0',
        meta: { name: 'test' },
        entryPoint: 'main',
        functions: [{
          id: 'main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [{ id: 'res', type: 'float3' }],
          nodes: [
            { id: 'v', op: 'float3', x: 1, y: 2, z: 3 },
            { id: 'sink', op: 'var_set', var: 'res', val: 'v' },
            { id: 'add', op: 'math_add', a: 'res', b: 'v' },
            { id: 'ret', op: 'func_return', val: 'add' }
          ]
        }],
        resources: [],
        inputs: []
      };
      const typeAnalysis = inferFunctionTypes(ir.functions[0], ir);
      expect(typeAnalysis.get('add')).toBe('float3');
    });
  });
});
