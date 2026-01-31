import { OpDefs, IRValueType } from './builtin-schemas';
import { Node, BuiltinOp, IRDocument, FunctionDef } from './types';

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
 *
 * If ir and func are provided, it also verifies that references actually exist.
 */
export function verifyLiteralsOrRefsExist(
  node: Node,
  ir?: IRDocument,
  func?: FunctionDef
): VerificationResult {
  const op = node.op as BuiltinOp;
  const def = OpDefs[op];
  const errors: string[] = [];

  if (!def) {
    // If not a builtin op, we don't have metadata to verify here.
    return { valid: true, errors: [] };
  }

  const nodeProps = node as unknown as Record<string, unknown>;

  for (const [key, argDef] of Object.entries(def.args)) {
    const value = nodeProps[key];

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
      } else if (ir || func) {
        if (!checkReferenceExists(value, ir, func)) {
          errors.push(`Argument '${key}' references unknown ID '${value}'`);
        }
      }
    } else {
      // It's either refable or a strict literal.
      if (isString && argDef.refable) {
        // It's a reference.
        if (ir || func) {
          if (!checkReferenceExists(value, ir, func)) {
            errors.push(`Argument '${key}' references unknown ID '${value}'`);
          }
        }
      } else {
        // It's a literal value.
        // We MUST validate the literal type if provided, OR if it's a strict literal.
        if (argDef.literalTypes) {
          const type = getLiteralType(value);
          if (!matchesLiteralTypes(type, argDef.literalTypes)) {
            errors.push(`Argument '${key}' has invalid literal type: expected one of [${argDef.literalTypes.join(', ')}], but got ${type}`);
          }
        } else if (!argDef.refable && isString) {
          // Strict literal that doesn't allow strings, but got a string.
          errors.push(`Argument '${key}' does not support references, but got string '${value}'`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Helper to check if a detected type matches any of the allowed literal types.
 */
function matchesLiteralTypes(detected: string, allowed: IRValueType[]): boolean {
  if (allowed.includes(detected as IRValueType)) return true;

  // Implicit conversions: int -> float
  if (detected === 'int' && allowed.includes('float')) return true;

  return false;
}

/**
 * Detects the IR literal type of a value.
 */
function getLiteralType(value: unknown): IRValueType | 'unknown' {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'float';
  }
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every(v => typeof v === 'number')) return 'float2';
    if (value.length === 3 && value.every(v => typeof v === 'number')) return 'float3';
    if (value.length === 4 && value.every(v => typeof v === 'number')) return 'float4';
    if (value.length === 9 && value.every(v => typeof v === 'number')) return 'float3x3';
    if (value.length === 16 && value.every(v => typeof v === 'number')) return 'float4x4';
    return 'array';
  }
  if (typeof value === 'object' && value !== null) return 'struct';
  return 'unknown';
}

/**
 * Helper to check if a string points to a valid reference in the IR document or function.
 */
function checkReferenceExists(id: string, ir?: IRDocument, func?: FunctionDef): boolean {
  // 1. Check Resources
  if (ir?.resources?.some(r => r.id === id)) return true;

  // 2. Check Inputs
  if (ir?.inputs?.some(i => i.id === id)) return true;

  // 3. Check Function Locals
  if (func?.localVars?.some(v => v.id === id)) return true;

  // 4. Check Other Nodes in Function
  if (func?.nodes?.some(n => n.id === id)) return true;

  // 5. Special Constants (optional, but keep it clean)
  if (id === 'screen') return true; // Common generic target

  return false;
}

/**
 * Introspection helper: returns whether a specific argument of an operation is a reference.
 * Returns true if the argument is a string AND the operation definition allows it to be a reference.
 */
export function isArgumentAReference(op: string, argName: string, value: unknown): boolean {
  const def = OpDefs[op as BuiltinOp];
  if (!def) return false;

  const argDef = def.args[argName];
  if (!argDef) return false;

  const isString = typeof value === 'string';

  if (argDef.requiredRef) return isString;
  if (argDef.refable) return isString;

  return false;
}
