import { describe, it, expect } from 'vitest';
import { validateEntity } from '../src/domain/verifier';
import { DatabaseState } from '../src/state/types';

// Mock State
const mockState: DatabaseState = {
  notes: {
    'n1': { id: 'n1', body: 'Note 1', refs: [], created_at: 0, updated_at: 0 },
    'n2': { id: 'n2', body: 'Note 2', refs: [], created_at: 0, updated_at: 0 }
  },
  chat_history: []
};

describe('Entity Verifier', () => {

  describe('Note Validation', () => {
    it('should pass a valid Note', () => {
      const note = {
        id: 'n_new',
        body: 'New Note',
        refs: ['n1'],
        created_at: Date.now(),
        updated_at: Date.now()
      };
      const errors = validateEntity(note as any, 'Note', mockState);
      expect(errors).toHaveLength(0);
    });

    it('should fail if Body is missing', () => {
      const note = {
        id: 'n_bad',
        // body missing
        refs: []
      };
      const errors = validateEntity(note as any, 'Note', mockState);
      expect(errors).toContainEqual(expect.objectContaining({ field: 'body', severity: 'error' }));
    });

    it('should pass if refs are missing (optional in schema)', () => {
      const note = {
        id: 'n_no_refs',
        body: 'Content',
        // refs missing
      };
      const errors = validateEntity(note as any, 'Note', mockState);
      expect(errors).toHaveLength(0);
    });

    it('should fail if refs contains non-existent ID', () => {
      const note = {
        id: 'n_fk_fail',
        body: 'FK Fail',
        refs: ['n1', 'n_ghost']
      };
      const errors = validateEntity(note as any, 'Note', mockState);

      // We expect a foreign key error
      expect(errors).toContainEqual(expect.objectContaining({
        field: 'refs[1]',
        message: 'Referenced Note ID "n_ghost" does not exist.'
      }));
    });

    it('should pass if refs list is empty', () => {
      const note = {
        id: 'n_empty_refs',
        body: 'Solo Note',
        refs: []
      };
      const errors = validateEntity(note as any, 'Note', mockState);
      expect(errors).toHaveLength(0);
    });
  });
});
