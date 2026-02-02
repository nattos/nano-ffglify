import { describe, it, expect } from 'vitest';
import { validateEntity } from '../src/domain/verifier';
import { DatabaseState } from '../src/state/types';

// Mock State
const mockState: DatabaseState = {
  ir: {
    id: 'current-ir',
    version: '3.0.0',
    meta: { name: 'Test IR' },
    entryPoint: 'main',
    inputs: [],
    resources: [],
    structs: [],
    functions: []
  },
  chat_history: []
};

describe('Entity Verifier', () => {

  describe('IR Validation', () => {
    it('should pass a valid IR', () => {
      const ir = {
        id: 'new-ir',
        version: '3.0.0',
        meta: { name: 'New IR' },
        entryPoint: 'fn_main',
        functions: []
      };
      const errors = validateEntity(ir as any, 'IR', mockState);
      expect(errors).toHaveLength(0);
    });

    it('should fail if version is missing', () => {
      const ir = {
        id: 'bad-ir',
        meta: { name: 'Bad' },
        entryPoint: 'main'
        // version missing
      };
      const errors = validateEntity(ir as any, 'IR', mockState);
      expect(errors).toContainEqual(expect.objectContaining({ field: 'version', severity: 'error' }));
    });

    it('should fail if meta.name is missing', () => {
      const ir = {
        version: '1.0',
        meta: {}, // name missing
        entryPoint: 'main'
      };
      const errors = validateEntity(ir as any, 'IR', mockState);
      expect(errors).toContainEqual(expect.objectContaining({ field: 'meta.name', severity: 'error' }));
    });

    it('should fail if inputs has invalid type', () => {
      const ir = {
        version: '1.0',
        meta: { name: 'Test' },
        entryPoint: 'main',
        inputs: 'not-an-array'
      };
      const errors = validateEntity(ir as any, 'IR', mockState);
      expect(errors).toContainEqual(expect.objectContaining({ field: 'inputs', message: expect.stringContaining('Expected array') }));
    });
  });
});
