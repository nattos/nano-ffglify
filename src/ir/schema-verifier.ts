import { OpDefs, IRValueType } from './builtin-schemas';
import { Node, BuiltinOp, IRDocument, FunctionDef } from './types';
import { z } from 'zod';

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
        errors.push(`Missing required argument '${key}'`);
      }
      continue;
    }

    validateArg(key, value, argDef, errors, ir, func);
  }

  // Check for unexpected extra keys
  const internalKeys = ['op', 'id', 'metadata', 'type', 'comment', 'next', '_next', 'exec_in', 'exec_out', 'exec_true', 'exec_false', 'exec_body', 'exec_completed', 'dataType', 'const_data'];
  const definedKeys = Object.keys(def.args);

  // Check for unexpected extra keys
  for (const key of Object.keys(nodeProps)) {
    if (internalKeys.includes(key) || definedKeys.includes(key)) continue;
    errors.push(`Unknown argument(s) '${key}' in operation '${op}'.`);
  }

  // Special handling for consolidated dynamic args: 'args' or 'values'
  // If these exist and contain a dictionary, we should check their content for refs.
  const dynamicKeys = ['args', 'values'];
  for (const dKey of dynamicKeys) {
    if (nodeProps[dKey] && typeof nodeProps[dKey] === 'object' && !Array.isArray(nodeProps[dKey])) {
      if (op === 'call_func' || op === 'cmd_dispatch') {
        const funcId = nodeProps['func'] as string;
        const targetFunc = ir?.functions?.find(f => f.id === funcId);
        if (targetFunc && nodeProps['args']) {
          const args = nodeProps['args'] as Record<string, any>;
          for (const [argKey, argVal] of Object.entries(args)) {
            const isInput = targetFunc.inputs.some(i => i.id === argKey);
            if (!isInput) {
              errors.push(`Unknown argument '${argKey}' in consolidated 'args' for function '${funcId}'`);
            }
          }
        }
      } else if (op === 'struct_construct') {
        const typeId = nodeProps['type'] as string;
        const structDef = ir?.structs?.find(s => s.id === typeId);
        if (structDef && nodeProps['values']) {
          const values = nodeProps['values'] as Record<string, any>;
          for (const [fieldKey, fieldVal] of Object.entries(values)) {
            if (!structDef.members.some(m => m.name === fieldKey)) {
              errors.push(`Unknown member '${fieldKey}' in consolidated 'values' for struct '${typeId}'`);
            }
          }
        }
      }

      const dict = nodeProps[dKey] as Record<string, unknown>;
      for (const [key, val] of Object.entries(dict)) {
        // Here we assume these are 'refable' by default as they are dynamic input args
        if (typeof val === 'string' && (ir || func)) {
          if (!checkReferenceExists(val, ir, func)) {
            errors.push(`Argument '${key}' in '${dKey}' references unknown ID '${val}'`);
          }
        }
      }
    } else if (nodeProps[dKey] && Array.isArray(nodeProps[dKey])) {
      // For array_construct values
      const arr = nodeProps[dKey] as unknown[];
      arr.forEach((val, idx) => {
        if (typeof val === 'string' && (ir || func)) {
          if (!checkReferenceExists(val, ir, func)) {
            errors.push(`Element at index ${idx} in '${dKey}' references unknown ID '${val}'`);
          }
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Inner validator for a single argument.
 */
function validateArg(
  key: string,
  value: unknown,
  argDef: any,
  errors: string[],
  ir?: IRDocument,
  func?: FunctionDef
) {
  const isString = typeof value === 'string';
  const isArray = Array.isArray(value);

  // Helper to check if a single value is a valid reference
  const checkRef = (v: any, portSuffix: string = '') => {
    if (typeof v === 'string' && (argDef.refable || argDef.requiredRef)) {
      if (ir || func) {
        if (!checkReferenceExists(v, ir, func)) {
          errors.push(`Argument '${key}${portSuffix}' references unknown ID '${v}'`);
          return false; // Reference does not exist
        }
      }
      return true; // Is a string and is refable/requiredRef, and exists if IR/func provided
    }
    return false; // Not a string, or not refable/requiredRef
  };

  // Helper to check if a literal value (or element) matches literalTypes
  const checkLiteral = (v: any, portSuffix: string = '') => {
    if (argDef.requiredRef) {
      errors.push(`Argument '${key}${portSuffix}' must be a reference (string), but got ${typeof v}`);
      return false;
    }

    if (!argDef.literalTypes) {
      if (!argDef.refable && typeof v === 'string') {
        const isActuallyStringLiteral = (argDef.type instanceof z.ZodString) || (argDef.type instanceof z.ZodEnum);
        if (!isActuallyStringLiteral) {
          errors.push(`Argument '${key}${portSuffix}' does not support references, but got string '${v}'`);
        }
      }
      return true;
    };

    const type = getLiteralType(v);

    // If we're checking an element of an array, and the schema expects vector types,
    // we should allow scalars (float/int) as elements.
    if (portSuffix !== '') {
      const expectsVector = argDef.literalTypes.some((t: string) => t.startsWith('float') && t.length > 5);
      if (expectsVector && (type === 'float' || type === 'int')) return true;
    }

    if (matchesLiteralTypes(type, argDef.literalTypes)) return true;

    errors.push(`Argument '${key}${portSuffix}' has invalid literal type: expected one of [${argDef.literalTypes.join(', ')}], but got ${type}`);
    return false;
  };

  // 1. requiredRef Case (must be reference(s))
  if (argDef.requiredRef) {
    if (argDef.isArray) {
      if (!isArray) {
        errors.push(`Argument '${key}' must be an array of references, but got ${typeof value}`);
      } else {
        (value as any[]).forEach((v, idx) => {
          if (!checkRef(v, `[${idx}]`)) {
            // If checkRef returns false, it means it's not a string or reference doesn't exist.
            // If it's not a string, we add a more specific error.
            if (typeof v !== 'string') {
              errors.push(`Element at index ${idx} in '${key}' must be a reference (string), but got ${typeof v}`);
            }
          }
        });
      }
    } else {
      if (!isString) {
        errors.push(`Argument '${key}' must be a reference (string), but got ${typeof value}`);
      } else {
        checkRef(value);
      }
    }
    return;
  }

  // 2. Refable / Literal Case
  // 2.1 Check if the WHOLE value is a reference
  if (isString && argDef.refable) {
    checkRef(value);
    return;
  }

  // 2.2 Check if the WHOLE value is a valid literal (matches schema)
  if (argDef.literalTypes) {
    const wholeType = getLiteralType(value);
    if (matchesLiteralTypes(wholeType, argDef.literalTypes)) {
      return;
    }
  }

  // 2.3 Handle arrays (mixed refs/literals or implicit arrays)
  if (isArray) {
    (value as any[]).forEach((v, idx) => {
      const wasRef = checkRef(v, `[${idx}]`);
      if (!wasRef) {
        checkLiteral(v, `[${idx}]`);
      }
    });
  } else {
    // 2.4 Single literal value
    checkLiteral(value);
  }
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

  // 5. Check Global Functions
  if (ir?.functions?.some(f => f.id === id)) return true;

  // 6. Special Constants (optional, but keep it clean)
  if (id === 'screen') return true; // Common generic target

  // 7. Function Inputs
  if (func?.inputs?.some(i => i.id === id)) return true;

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
