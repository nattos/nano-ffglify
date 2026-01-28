/**
 * @file verifier.ts
 * @description Provides runtime validation for entities against the database state.
 * Ensured referential integrity (e.g., that referenced IDs actually exist).
 *
 * @external-interactions
 * - Called by `chat-handler.ts` before executing `upsertEntity` to prevent invalid data corruption.
 *
 * @pitfalls
 * - Currently manual; ideally should derive validation rules directly from `schemas.ts` to avoid duplication.
 */
import { ALL_SCHEMAS, DatabaseState, Note, ValidationError } from './types';
import { DeepPartial } from '../utils/utils';
import { FieldSchema } from './schemas';

// --- Generic Schema Validator ---

function validateField(value: any, schema: FieldSchema, path: string, errors: ValidationError[]) {
  if (value === undefined || value === null) {
    if (schema.required) {
      errors.push({ field: path, message: `Field '${path}' is required`, severity: 'error' });
    }
    return;
  }

  // Type Check
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ field: path, message: `Expected array at '${path}'`, severity: 'error' });
      return;
    }
    if (schema.items) {
      value.forEach((item, i) => validateField(item, schema.items!, `${path}[${i}]`, errors));
    }
  } else if (schema.type === 'object') {
    if (typeof value !== 'object') {
      errors.push({ field: path, message: `Expected object at '${path}'`, severity: 'error' });
      return;
    }
    if (schema.properties) {
      for (const [key, fieldSchema] of Object.entries(schema.properties)) {
        validateField(value[key], fieldSchema, `${path}.${key}`, errors);
      }
    }
  } else {
    // Primitives
    if (typeof value !== schema.type) {
      if (schema.type === 'number' && typeof value === 'string' && !isNaN(Number(value))) {
        // Acceptable coercion
      } else {
        errors.push({ field: path, message: `Expected ${schema.type} at '${path}', got ${typeof value}`, severity: 'error' });
      }
    }
    // Enum Check
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({ field: path, message: `Invalid value '${value}'. Expected one of: ${schema.enum.join(', ')}`, severity: 'error' });
    }
  }
}

export function validateEntity(
  entity: DeepPartial<any> | null | undefined,
  type: string,
  state: DatabaseState
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!entity) {
    errors.push({ field: 'root', message: 'Entity is null or undefined', severity: 'error' });
    return errors;
  }

  // 1. Schema Validation
  const schema = ALL_SCHEMAS[type as keyof typeof ALL_SCHEMAS];
  if (schema) {
    for (const [key, fieldSchema] of Object.entries(schema.fields)) {
      validateField((entity as any)[key], fieldSchema, key, errors);
    }
  } else {
    console.warn(`No schema definition for ${type}`);
  }

  // 2. Custom Logic / Cross-Entity Validation
  switch (type) {
    case 'Note':
      validateNote(entity as DeepPartial<Note>, state, errors);
      break;
  }

  return errors;
}

function validateNote(note: DeepPartial<Note>, state: DatabaseState, errors: ValidationError[]) {
  // Validate Foreign Keys in 'refs'
  if (note.refs && Array.isArray(note.refs)) {
    note.refs.forEach((refId, idx) => {
      if (typeof refId === 'string') {
        if (!state.notes[refId]) {
          errors.push({
            field: `refs[${idx}]`,
            message: `Referenced Note ID "${refId}" does not exist.`,
            severity: 'warning' // Warning because maybe we haven't synced yet, or creating circular ref?
          });
        }
      }
    });
  }
}
