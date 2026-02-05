/**
 * @file verifier.ts
 * @description Provides structural validation for entities against the IRSchema.
 * This ensures that data saved to the database matches the expected JSON structure.
 *
 * @policy "Allow Logic Mistakes"
 * We do NOT perform full IR logic validation (e.g., node existence, type matching) here.
 * The agent is allowed to make mistakes in the shader graph logic. These errors are
 * detected during the separate "Validate IR" or "Compile IR" steps in the UI and
 * provided back to the agent in the conversation context.
 *
 * @external-interactions
 * - Called by `chat-handler.ts` before executing `upsertEntity` to prevent malformed data.
 *
 * @pitfalls
 * - Structural validation only. Does not guarantee a compilable shader.
 */
import { ALL_SCHEMAS, DatabaseState, ValidationError, IRDocument } from './types';
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
  if (schema.type === 'any') {
    return; // Accept anything
  }

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
      } else if (schema.type === 'number' && Array.isArray(value)) {
        // Acceptable for vector sizes [w, h]
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
    case 'IR':
      validateIR(entity as DeepPartial<IRDocument>, state, errors);
      break;
  }

  return errors;
}

function validateIR(ir: DeepPartial<IRDocument>, state: DatabaseState, errors: ValidationError[]) {
  // Placeholder for IR-specific cross-entity or complex validation
}
