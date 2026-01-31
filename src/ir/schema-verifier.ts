import { OpDefs } from './builtin-schemas';
import { Node, BuiltinOp } from './types';

/**
 * Result of the literal/reference verification.
 */
export interface VerificationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Verifies that the given node's arguments correctly use literals or references
 * based on the operation's definition.
 *
 * Unlike standard Zod validation, this utility allows for precise introspection
 * of which fields are intended to be references vs literal values.
 */
export function verifyLiteralsOrRefsExist(node: Node): VerificationResult {
  const op = node.op as BuiltinOp;
  const def = OpDefs[op];
  const errors: string[] = [];

  if (!def) {
    // If not a builtin op, we don't have metadata to verify here.
    return { valid: true, errors: [] };
  }

  for (const [key, argDef] of Object.entries(def.args)) {
    const value = (node as any)[key];

    // Optional argument handling
    if (value === undefined) {
      if (!argDef.optional) {
        errors.push(`Missing required argument: ${key}`);
      }
      continue;
    }

    const isString = typeof value === 'string';

    if (argDef.requiredRef) {
      if (!isString) {
        errors.push(`Argument '${key}' must be a reference (string), but got ${typeof value}`);
      }
    } else if (argDef.refable) {
      // Both literals and references are allowed.
      // We don't need to do anything here because Zod handles the union check.
      // This is primarily for introspection by other tools.
    } else {
      // Must be a literal (no references allowed)
      if (isString) {
        errors.push(`Argument '${key}' does not support references, but got string '${value}'`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Introspection helper: returns whether a specific argument of an operation is a reference.
 * Returns true if the argument is a string AND the operation definition allows it to be a reference.
 */
export function isArgumentAReference(op: string, argName: string, value: any): boolean {
  const def = OpDefs[op as BuiltinOp];
  if (!def) return false;

  const argDef = def.args[argName];
  if (!argDef) return false;

  const isString = typeof value === 'string';

  if (argDef.requiredRef) return isString;
  if (argDef.refable) return isString;

  return false;
}
