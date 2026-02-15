/**
 * IR Logic Validator
 *
 * IMPORTANT: Avoid putting large inline lists of operation names or categories
 * directly in this file. Move such metadata to src/ir/builtin-schemas.ts or
 * src/ir/signatures.ts instead.
 */
import { IRDocument, FunctionDef, BuiltinOp, BLITTABLE_TYPES } from './types';
import { OpSignatures, OpSignature, ValidationType } from './signatures';
import { OpSchemas, OpDefs, BUILTIN_TYPES, BUILTIN_CPU_ALLOWED } from './builtin-schemas';
import { verifyLiteralsOrRefsExist } from './schema-verifier';

import { TextureFormat, Edge, PRIMITIVE_TYPES } from './types';
import { reconstructEdges } from './utils';

// Local Error Type (Internal to logic validator, mapped by schema.ts)
export interface LogicValidationError {
  nodeId?: string;
  functionId?: string;
  message: string;
  severity: 'error' | 'warning';
}

export const validateStaticLogic = (doc: IRDocument): LogicValidationError[] => {
  const errors: LogicValidationError[] = [];

  // Global Context for Type Resolution
  const resourceIds = new Set([
    ...(doc.resources || []).map(r => r.id),
    ...(doc.inputs || []).map(i => i.id)
  ]);

  // Check Entry Point
  if (!doc.functions.some(f => f.id === doc.entryPoint)) {
    errors.push({
      message: `Entry point '${doc.entryPoint}' not found in functions`,
      severity: 'error'
    });
  }

  // Check Resources
  validateResources(doc, errors);

  // Check Inputs
  validateInputs(doc, errors);

  // Check Struct Definitions
  validateStructs(doc, errors);

  doc.functions.forEach(func => {
    validateFunction(func, doc, resourceIds, errors);
  });

  return errors;
};

export interface FunctionAnalysis {
  inferredTypes: InferredTypes;
  usedBuiltins: Set<string>;
  usedResourceSizes: Set<string>;
}

export const inferFunctionTypes = (func: FunctionDef, ir: IRDocument): InferredTypes => {
  return analyzeFunction(func, ir).inferredTypes;
};

export const analyzeFunction = (func: FunctionDef, ir: IRDocument): FunctionAnalysis => {
  const resourceIds = new Set([
    ...(ir.resources || []).map(r => r.id),
    ...(ir.inputs || []).map(i => i.id)
  ]);
  const cache: InferredTypes = new Map();
  const usedBuiltins = new Set<string>();
  const errors: LogicValidationError[] = [];
  const edges = reconstructEdges(func, ir);
  func.nodes.forEach(node => {
    resolveNodeType(node.id, func, ir, cache, resourceIds, errors, edges, usedBuiltins);
  });
  // Collect resources queried by resource_get_size
  const usedResourceSizes = new Set<string>();
  for (const node of func.nodes) {
    if (node.op === 'resource_get_size' && typeof node['resource'] === 'string') {
      usedResourceSizes.add(node['resource'] as string);
    }
  }
  return { inferredTypes: cache, usedBuiltins, usedResourceSizes };
};

export const validateIR = (doc: IRDocument): LogicValidationError[] => {
  return validateStaticLogic(doc);
};

// ------------------------------------------------------------------
// Type Inference Engine
// ------------------------------------------------------------------
type TypeCache = Map<string, ValidationType>;

export type InferredTypes = Map<string, ValidationType>;

const resolveSwizzleType = (
  baseType: ValidationType,
  swizzle: string,
  nodeId: string,
  functionId: string,
  errors: LogicValidationError[]
): ValidationType => {
  const validComps = ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a'];
  const isIntVec = baseType === 'int2' || baseType === 'int3' || baseType === 'int4';
  const isFloatVec = baseType === 'float2' || baseType === 'float3' || baseType === 'float4';

  if (!isIntVec && !isFloatVec) {
    errors.push({ nodeId, functionId, message: `Cannot swizzle non-vector type '${baseType}'`, severity: 'error' });
    return 'any';
  }

  let maxComp = 0;
  if (baseType === 'float2' || baseType === 'int2') maxComp = 2;
  else if (baseType === 'float3' || baseType === 'int3') maxComp = 3;
  else if (baseType === 'float4' || baseType === 'int4') maxComp = 4;

  if (swizzle.length < 1 || swizzle.length > 4) {
    errors.push({ nodeId, functionId, message: `Invalid swizzle mask length '${swizzle}'`, severity: 'error' });
    return 'any';
  }

  for (const char of swizzle) {
    const idx = validComps.indexOf(char);
    if (idx === -1) {
      errors.push({ nodeId, functionId, message: `Invalid swizzle component '${char}'`, severity: 'error' });
      return 'any';
    }
    const effectiveIdx = idx % 4;
    if (effectiveIdx >= maxComp) {
      errors.push({ nodeId, functionId, message: `Swizzle component '${char}' out of bounds for ${baseType}`, severity: 'error' });
      return 'any';
    }
  }

  const scalarType = isIntVec ? 'int' : 'float';
  const vecPrefix = isIntVec ? 'int' : 'float';
  return (swizzle.length === 1 ? scalarType : `${vecPrefix}${swizzle.length}`) as ValidationType;
};

const resolveNodeType = (
  nodeId: string,
  func: FunctionDef,
  doc: IRDocument,
  cache: TypeCache,
  resourceIds: Set<string>,
  errors: LogicValidationError[],
  edges: Edge[],
  usedBuiltins: Set<string> = new Set()
): ValidationType => {
  const functionId = func.id;
  if (cache.has(nodeId)) return cache.get(nodeId)!;

  const node = func.nodes.find(n => n.id === nodeId);
  if (!node) return 'any';

  // Sentinel to break recursion cycles
  cache.set(nodeId, 'any');

  // console.log(`[Validator] Resolving ${node.id} (${node.op})`);

  const sigs = OpSignatures[node.op as keyof typeof OpSignatures];
  if (!sigs) {
    // console.log(`[Validator] No signatures found for op ${node.op}`);
    errors.push({
      nodeId,
      functionId,
      message: `Unknown op '${node.op}'`,
      severity: 'error'
    });
    cache.set(nodeId, 'any');
    return 'any';
  }

  // Resolve Inputs
  const inputTypes: Record<string, ValidationType> = {};

  // 1. Gather Input Types from Edges
  const incomingEdges = edges.filter(e => e.to === nodeId && e.type === 'data');
  incomingEdges.forEach(edge => {
    let srcType = resolveNodeType(edge.from, func, doc, cache, resourceIds, errors, edges, usedBuiltins);
    const port = edge.portIn;

    // Apply inline swizzle if the original property value has a "." suffix
    const propVal = node[port];
    if (typeof propVal === 'string' && propVal.includes('.')) {
      const dotIdx = propVal.indexOf('.');
      const swizzle = propVal.substring(dotIdx + 1);
      if (swizzle.length > 0) {
        // If srcType is 'any' (e.g., edge.from is a local var not in node list), resolve from local vars/inputs
        if (srcType === 'any') {
          const baseId = propVal.substring(0, dotIdx);
          const localVar = func.localVars?.find(v => v.id === baseId);
          const funcInput = func.inputs?.find(i => i.id === baseId);
          const globalInput = doc.inputs?.find(i => i.id === baseId);
          if (localVar) srcType = localVar.type as ValidationType;
          else if (funcInput) srcType = funcInput.type as ValidationType;
          else if (globalInput) srcType = globalInput.type as ValidationType;
        }
        srcType = resolveSwizzleType(srcType, swizzle, nodeId, functionId, errors);
      }
    }

    // Handle path resolution: if edge is to 'args.foo', update 'foo' in inputTypes
    if (port.startsWith('args.')) {
      inputTypes[port.substring(5)] = srcType;
    } else if (port.startsWith('values.')) {
      inputTypes[port.substring(7)] = srcType;
    } else if (port.startsWith('values[')) {
      // Just mark that we have some values if it's an array
      inputTypes['values'] = 'array';
    } else {
      inputTypes[port] = srcType;
    }
  });

  // 2. Gather Input Types from Literal Props
  const reservedKeys = new Set(['id', 'op', 'metadata', 'exec_in', 'exec_out', 'exec_true', 'exec_false', 'exec_body', 'exec_completed', '_next', 'next', 'args', 'values', 'comment', 'id_var', 'id_val']);

  const processArg = (key: string, val: any) => {
    if (inputTypes[key]) return;
    if (val === undefined) return;

    if (Array.isArray(val)) {
      if (val.length === 2) inputTypes[key] = 'float2';
      else if (val.length === 3) inputTypes[key] = 'float3';
      else if (val.length === 4) inputTypes[key] = 'float4';
      else if (val.length === 9) inputTypes[key] = 'float3x3';
      else if (val.length === 16) inputTypes[key] = 'float4x4';
      else inputTypes[key] = 'array';
    } else if (typeof val === 'number') {
      inputTypes[key] = 'float';
    } else if (typeof val === 'boolean') {
      inputTypes[key] = 'boolean';
    } else if (typeof val === 'string') {
      const def = OpDefs[node.op as BuiltinOp];
      const isNameProperty = def?.args[key]?.isIdentifier ?? false;

      // Inline swizzle support: split "nodeId.xyz" into base + swizzle
      let baseVal = val;
      let swizzle: string | undefined;
      const dotIdx = val.indexOf('.');
      if (dotIdx !== -1 && !isNameProperty) {
        baseVal = val.substring(0, dotIdx);
        swizzle = val.substring(dotIdx + 1);
      }

      const refNode = func.nodes.find(n => n.id === baseVal);
      const refInput = func.inputs.find(i => i.id === baseVal);
      const refLocal = func.localVars.find(v => v.id === baseVal);
      const refGlobal = doc.inputs?.find(i => i.id === baseVal);

      let baseType: ValidationType | undefined;

      if (refNode && !isNameProperty) {
        if (refNode.op === 'comment') {
          errors.push({ nodeId, functionId, message: `Node '${nodeId}' cannot reference comment node '${baseVal}'`, severity: 'error' });
        }
        baseType = resolveNodeType(baseVal, func, doc, cache, resourceIds, errors, edges);
      } else if (refInput && !isNameProperty) {
        baseType = refInput.type as ValidationType;
      } else if (refLocal && !isNameProperty) {
        baseType = refLocal.type as ValidationType;
      } else if (refGlobal && !isNameProperty) {
        baseType = refGlobal.type as ValidationType;
      }

      if (baseType !== undefined) {
        if (swizzle) {
          const swizzleResult = resolveSwizzleType(baseType, swizzle, nodeId, functionId, errors);
          inputTypes[key] = swizzleResult;
        } else {
          inputTypes[key] = baseType;
        }
      } else {
        inputTypes[key] = 'string';
      }
    }
  };

  Object.keys(node).forEach(key => {
    if (reservedKeys.has(key)) return;
    processArg(key, node[key]);
  });

  // Handle consolidated args/values in literals
  if (node['args'] && typeof node['args'] === 'object' && !Array.isArray(node['args'])) {
    Object.entries(node['args']).forEach(([k, v]) => processArg(k, v));
  }
  if (node['values'] && typeof node['values'] === 'object') {
    if (Array.isArray(node['values'])) {
      inputTypes['values'] = 'array';
    } else {
      Object.entries(node['values']).forEach(([k, v]) => processArg(k, v));
    }
  }

  // 3. New Zod Schema Validation
  const zodSchema = OpSchemas[node.op as BuiltinOp];
  if (zodSchema) {
    // We only validate literal properties and existence of data edges.
    // We don't validate the TYPES of data edges yet here, because that's what ResolveNodeType is doing recursively.
    // However, for commands like cmd_draw, we can validate the static config.

    // Create a data object for Zod validation consisting of ONLY literal props
    const validationData: any = {};
    Object.keys(node).forEach(key => {
      if (!reservedKeys.has(key)) validationData[key] = node[key];
    });

    const result = zodSchema.partial().safeParse(validationData);

    if (!result.success) {
      result.error.issues.forEach(issue => {
        errors.push({
          nodeId,
          functionId,
          message: `Schema Error in '${node.op}': ${issue.path.join('.')}: ${issue.message}`,
          severity: 'error'
        });
      });
    }

  }

  // 4. Match against Overloads (Signature-based inference)
  // Two-pass: first allow only scalar int<->float coercion (needed because
  // numeric literals are always typed 'float'), then allow vector coercion.
  // This ensures vec_get_element(int3, 0) matches the int3->int signature
  // before the float3->float signature.

  let matchedSig: OpSignature | undefined;

  const matchSig = (sig: OpSignature, allowVectorCoercion: boolean): boolean => {
    let match = true;
    const hasWildcard = '*' in sig.inputs;

    for (const [argName, argType] of Object.entries(sig.inputs)) {
      if (argName === '*') continue;

      let providedType = inputTypes[argName] as string;

      // Normalize Types
      if (providedType === 'bool') providedType = 'boolean';

      // Support Named Structs
      if (argType === 'struct' && providedType !== 'any') {
        const isNamedStruct = doc.structs?.some(s => s.id === providedType);
        if (isNamedStruct) providedType = 'struct';
      }

      if (!providedType) {
        match = false;
        break;
      }

      if (argType !== 'any' && providedType !== 'any' && argType !== providedType) {
        // Always allow scalar int<->float (literals are typed 'float')
        if ((argType === 'float' && providedType === 'int') ||
          (argType === 'int' && providedType === 'float')) continue;
        // Only allow vector int<->float coercion in pass 2
        if (allowVectorCoercion) {
          if ((argType === 'float2' && providedType === 'int2') ||
            (argType === 'int2' && providedType === 'float2') ||
            (argType === 'float3' && providedType === 'int3') ||
            (argType === 'int3' && providedType === 'float3') ||
            (argType === 'float4' && providedType === 'int4') ||
            (argType === 'int4' && providedType === 'float4')) continue;
        }

        match = false;
        break;
      }
    }

    if (match) {
      // Arity Check
      const extraKeys = Object.keys(inputTypes).filter(k => !(k in sig.inputs) && !hasWildcard);
      if (extraKeys.length > 0) return false;
      return true;
    }
    return false;
  };

  // Pass 1: scalar int<->float only (no vector coercion)
  for (const sig of sigs) {
    if (matchSig(sig, false)) {
      matchedSig = sig;
      break;
    }
  }
  // Pass 2: also allow vector int<->float coercion
  if (!matchedSig) {
    for (const sig of sigs) {
      if (matchSig(sig, true)) {
        matchedSig = sig;
        break;
      }
    }
  }

  // Reject mixed int/float vector args in binary math/comparison ops.
  // These match via Pass 2 coercion but cause backend compilation failures
  // (e.g. Metal does not allow implicit int2↔float2 conversion).
  const BINARY_VEC_STRICT_OPS = new Set([
    'math_add', 'math_sub', 'math_mul', 'math_div', 'math_mod',
    'math_pow', 'math_min', 'math_max', 'math_atan2',
    'math_gt', 'math_lt', 'math_ge', 'math_le', 'math_eq', 'math_neq',
  ]);
  if (matchedSig && BINARY_VEC_STRICT_OPS.has(node.op)) {
    const aType = inputTypes['a'];
    const bType = inputTypes['b'];
    if (aType && bType && aType !== 'any' && bType !== 'any') {
      const isIntVec = (t: string) => /^int[234]$/.test(t);
      const isFloatVec = (t: string) => /^float[234]$/.test(t);
      if ((isIntVec(aType) && isFloatVec(bType)) || (isFloatVec(aType) && isIntVec(bType))) {
        const dim = aType.replace(/^(float|int)/, '');
        errors.push({
          nodeId, functionId,
          message: `Type mismatch in '${node.op}': cannot implicitly convert between '${aType}' and '${bType}'. Use static_cast_float${dim} or static_cast_int${dim}.`,
          severity: 'error'
        });
      }
    }
  }

  if (matchedSig) {
    if (node.op === 'var_set' && inputTypes['val'] && inputTypes['val'] !== 'any') {
      cache.set(nodeId, inputTypes['val']);
      return inputTypes['val'];
    }

    if (node.op === 'builtin_get') {
      const name = node['name'];
      usedBuiltins.add(name);
      const type = BUILTIN_TYPES[name];
      if (type) {
        cache.set(nodeId, type as ValidationType);
        return type as ValidationType;
      }
    }

    if (node.op === 'literal') {
      const explicitType = node['type'];
      if (explicitType) {
        const validLiteralTypes = ['float', 'int', 'boolean', 'bool', 'float2', 'float3', 'float4', 'int2', 'int3', 'int4', 'float3x3', 'float4x4'];
        if (validLiteralTypes.includes(explicitType)) {
          const normalizedType = (explicitType === 'bool' ? 'boolean' : explicitType) as ValidationType;
          cache.set(nodeId, normalizedType);
          return normalizedType;
        }
        errors.push({ nodeId, functionId, message: `Invalid explicit type '${explicitType}' on literal node`, severity: 'error' });
      }
      const val = node['val'];
      if (typeof val === 'number') {
        cache.set(nodeId, 'float');
        return 'float';
      } else if (typeof val === 'boolean') {
        cache.set(nodeId, 'boolean');
        return 'boolean';
      }
    }

    if (node.op === 'mat_identity') {
      const size = node['size'];
      const vType = (size === 3) ? 'float3x3' : 'float4x4';
      cache.set(nodeId, vType);
      return vType;
    }

    if (node.op === 'mat_transpose' || node.op === 'mat_inverse') {
      const valType = inputTypes['val'];
      if (valType && valType !== 'any') {
        cache.set(nodeId, valType);
        return valType;
      }
    }

    if (node.op === 'struct_construct') {
      const type = node['type'];
      if (type) {
        cache.set(nodeId, type as ValidationType);
        return type as ValidationType;
      }
    }

    if (node.op === 'array_construct') {
      let type = node['type'];
      if (!type) {
        const fillType = inputTypes['fill'];
        if (fillType && fillType !== 'any') {
          type = fillType;
        } else if (Array.isArray(node['values']) && node['values'].length > 0) {
          const firstVal = node['values'][0];
          if (typeof firstVal === 'string' && func.nodes.some(n => n.id === firstVal)) {
            type = resolveNodeType(firstVal, func, doc, cache, resourceIds, errors, edges);
          } else if (typeof firstVal === 'number') {
            type = 'float';
          } else if (typeof firstVal === 'boolean') {
            type = 'boolean';
          }
        }
      }
      if (!type) type = 'float';

      let len = 0;
      if (Array.isArray(node['values'])) len = node['values'].length;
      else if (typeof node['length'] === 'number') len = node['length'];

      // Normalize internal type names to official IR types
      let scalarType = type;
      if (type === 'float') scalarType = 'float';
      else if (type === 'int') scalarType = 'int';
      else if (type === 'bool' || type === 'boolean') scalarType = 'bool';


      const arrayType = `array<${scalarType}, ${len}>`;
      cache.set(nodeId, arrayType);
      return arrayType;
    }

    if (node.op === 'var_get') {
      const varId = node['var'];
      const localVar = func.localVars.find(v => v.id === varId);
      const globalVar = doc.inputs?.find(i => i.id === varId);
      const funcInput = func.inputs.find(i => i.id === varId);
      const type = localVar?.type || funcInput?.type || globalVar?.type || 'float';
      const vType = type as ValidationType;
      cache.set(nodeId, vType);
      return vType;
    }

    if (node.op === 'buffer_load') {
      const resId = node['buffer'];
      const resDef = doc.resources?.find(r => r.id === resId);

      const type = resDef?.dataType || 'float';
      // Normalize 'floatN' to internal ValidationType
      let vType = type as ValidationType;
      if (type === 'float') vType = 'float';
      else if (type === 'int') vType = 'int';
      else if (type === 'bool' || type === 'boolean') vType = 'boolean';
      else if (type === 'float2') vType = 'float2';
      else if (type === 'float3') vType = 'float3';
      else if (type === 'float4') vType = 'float4';
      else if (type === 'float3x3') vType = 'float3x3';
      else if (type === 'float4x4') vType = 'float4x4';

      cache.set(nodeId, vType);
      return vType;
    }

    // Atomic ops always produce int
    if (node.op === 'atomic_load' || node.op === 'atomic_add' || node.op === 'atomic_sub' ||
        node.op === 'atomic_min' || node.op === 'atomic_max' || node.op === 'atomic_exchange') {
      cache.set(nodeId, 'int');
      return 'int';
    }

    if (node.op === 'array_extract') {
      const arrayType = inputTypes['array'];
      if (!arrayType || arrayType === 'any') {
        cache.set(nodeId, 'any');
        return 'any';
      }

      // Handle array<Type, N> or array<Type>
      if (arrayType.startsWith('array<')) {
        // format: array<scalarType, length> or array<scalarType>
        const match = arrayType.match(/^array<(\w+)(?:,\s*\d+)?>/);
        if (match) {
          const sType = match[1];
          // Map back to ValidationType
          if (sType === 'float') { cache.set(nodeId, 'float'); return 'float'; }
          if (sType === 'int') { cache.set(nodeId, 'int'); return 'int'; }
          if (sType === 'bool' || sType === 'boolean') { cache.set(nodeId, 'boolean'); return 'boolean'; }
          // If it is a struct name or other type
          cache.set(nodeId, sType as ValidationType);
          return sType as ValidationType;
        }
      }

      // Handle vectors (e.g. float4 -> float, int3 -> int)
      if (arrayType === 'float2' || arrayType === 'float3' || arrayType === 'float4') {
        cache.set(nodeId, 'float'); return 'float';
      }
      if (arrayType === 'int2' || arrayType === 'int3' || arrayType === 'int4') {
        cache.set(nodeId, 'int'); return 'int';
      }

      cache.set(nodeId, 'any');
      return 'any';
    }

    if (node.op === 'struct_extract') {
      const structType = inputTypes['struct']; // 'any' or struct ID
      if (!structType || structType === 'any') {
        cache.set(nodeId, 'any');
        return 'any';
      }
      // If structType is a struct ID, look up struct definition
      const structDef = doc.structs?.find(s => s.id === structType);
      if (structDef) {
        const field = node['field'];
        const member = structDef.members.find(m => m.name === field);
        if (member) {
          let mType = member.type as ValidationType;
          if (mType === 'float') mType = 'float';
          else if (mType === 'int') mType = 'int';

          cache.set(nodeId, mType);
          return mType;
        }
      }
      cache.set(nodeId, 'any');
      return 'any';
    }

    // Vec Swizzle Logic
    if (node.op === 'vec_swizzle') {
      const inputType = inputTypes['vec'];
      const mask = node['channels'];

      if (typeof mask !== 'string') {
        errors.push({ nodeId, functionId, message: 'Swizzle mask must be a string literal', severity: 'error' });
        cache.set(nodeId, 'any'); return 'any';
      }

      const validComps = ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a'];
      if (mask.length < 1 || mask.length > 4) {
        errors.push({ nodeId, functionId, message: `Invalid swizzle mask length '${mask}'`, severity: 'error' });
      }

      let maxComp = 0;
      const isIntVec = inputType === 'int2' || inputType === 'int3' || inputType === 'int4';
      if (inputType === 'float2' || inputType === 'int2') maxComp = 2;
      else if (inputType === 'float3' || inputType === 'int3') maxComp = 3;
      else if (inputType === 'float4' || inputType === 'int4') maxComp = 4;

      if (maxComp > 0) {
        for (const char of mask) {
          const idx = validComps.indexOf(char);
          if (idx === -1) {
            errors.push({ nodeId, functionId, message: `Invalid swizzle component '${char}'`, severity: 'error' });
          } else {
            const effectiveIdx = idx % 4;
            if (effectiveIdx >= maxComp) {
              errors.push({ nodeId, functionId, message: `Swizzle component '${char}' out of bounds for ${inputType}`, severity: 'error' });
            }
          }
        }
        const scalarType = isIntVec ? 'int' : 'float';
        const vecPrefix = isIntVec ? 'int' : 'float';
        const outType = mask.length === 1 ? scalarType : `${vecPrefix}${mask.length}` as ValidationType;
        cache.set(nodeId, outType);
        return outType;
      }
    }

    // Flexible vector constructor validation (matched via wildcard signature)
    const VECTOR_CONSTRUCTOR_OPS: Record<string, { dim: number, scalarType: ValidationType, outType: ValidationType }> = {
      'float2': { dim: 2, scalarType: 'float', outType: 'float2' },
      'float3': { dim: 3, scalarType: 'float', outType: 'float3' },
      'float4': { dim: 4, scalarType: 'float', outType: 'float4' },
      'int2': { dim: 2, scalarType: 'int', outType: 'int2' },
      'int3': { dim: 3, scalarType: 'int', outType: 'int3' },
      'int4': { dim: 4, scalarType: 'int', outType: 'int4' },
    };
    const vecInfo = VECTOR_CONSTRUCTOR_OPS[node.op];
    if (vecInfo && matchedSig.inputs['*'] !== undefined) {
      // Matched via wildcard — validate component groups
      const compOrder = ['x', 'y', 'z', 'w'];
      const groups: { key: string, startIdx: number, count: number }[] = [];
      const compGroupPattern = /^[xyzw]+$/;

      for (const key of Object.keys(inputTypes)) {
        if (!compGroupPattern.test(key)) {
          errors.push({ nodeId, functionId, message: `Invalid component-group key '${key}' for ${node.op}`, severity: 'error' });
          continue;
        }
        const startIdx = compOrder.indexOf(key[0]);
        if (startIdx === -1) {
          errors.push({ nodeId, functionId, message: `Invalid component '${key[0]}' in key '${key}'`, severity: 'error' });
          continue;
        }
        // Validate contiguous
        let contiguous = true;
        for (let i = 0; i < key.length; i++) {
          if (compOrder[startIdx + i] !== key[i]) { contiguous = false; break; }
        }
        if (!contiguous) {
          errors.push({ nodeId, functionId, message: `Component-group key '${key}' must be contiguous (e.g. 'xy', 'xyz')`, severity: 'error' });
          continue;
        }
        groups.push({ key, startIdx, count: key.length });
      }

      // Sort by start index
      groups.sort((a, b) => a.startIdx - b.startIdx);

      // Validate no gaps, no overlaps, total = dim
      let expectedStart = 0;
      for (const g of groups) {
        if (g.startIdx !== expectedStart) {
          errors.push({ nodeId, functionId, message: `Component-group gap or overlap: expected component at index ${expectedStart}, got '${g.key}' at index ${g.startIdx}`, severity: 'error' });
        }
        expectedStart = g.startIdx + g.count;
      }
      if (expectedStart !== vecInfo.dim) {
        errors.push({ nodeId, functionId, message: `Component groups cover ${expectedStart} components, but ${node.op} requires ${vecInfo.dim}`, severity: 'error' });
      }

      // Validate arg types: scalar ok (broadcast), vector must match component count
      for (const g of groups) {
        const argType = inputTypes[g.key];
        if (!argType || argType === 'any') continue;
        const isScalar = argType === 'float' || argType === 'int' || argType === 'boolean';
        if (isScalar) continue; // scalar broadcast is always ok
        // Check if it's a matching-dimension vector
        const vecDimMatch: Record<string, number> = { float2: 2, float3: 3, float4: 4, int2: 2, int3: 3, int4: 4 };
        const argDim = vecDimMatch[argType];
        if (argDim !== undefined) {
          if (argDim !== g.count) {
            errors.push({ nodeId, functionId, message: `Component-group '${g.key}' expects ${g.count} components, but got ${argType} (${argDim})`, severity: 'error' });
          }
        }
      }

      cache.set(nodeId, vecInfo.outType);
      return vecInfo.outType;
    }

    cache.set(nodeId, matchedSig.output);
    return matchedSig.output;
  }

  const refSig = sigs[0];

  // Check for Unknown Arguments (Fallback)
  const hasWildcard = '*' in refSig.inputs;
  const extraKeys = Object.keys(inputTypes).filter(k => !(k in refSig.inputs) && !hasWildcard);
  if (extraKeys.length > 0) {
    errors.push({
      nodeId,
      functionId,
      message: `Unknown argument(s) '${extraKeys.join(', ')}' for op '${node.op}'`,
      severity: 'error'
    });
  }

  for (const reqArg of Object.keys(refSig.inputs)) {
    if (reqArg === '*') continue;
    if (!inputTypes[reqArg]) {
      errors.push({ nodeId, functionId, message: `Missing required argument '${reqArg}' for op '${node.op}'`, severity: 'error' });
    }
  }
  for (const [argName, argType] of Object.entries(refSig.inputs)) {
    const providedType = inputTypes[argName];
    if (providedType && argType !== 'any' && providedType !== 'any' && argType !== providedType) {
      if ((argType === 'float' && providedType === 'int') ||
        (argType === 'int' && providedType === 'float')) continue;
      if ((argType === 'float2' && providedType === 'int2') ||
        (argType === 'int2' && providedType === 'float2') ||
        (argType === 'float3' && providedType === 'int3') ||
        (argType === 'int3' && providedType === 'float3') ||
        (argType === 'float4' && providedType === 'int4') ||
        (argType === 'int4' && providedType === 'float4')) continue;
      errors.push({ nodeId, functionId, message: `Type Mismatch at '${argName}': expected ${argType}, got ${providedType}`, severity: 'error' });
    }
  }

  cache.set(nodeId, 'any');
  return 'any';
};

const validateDataType = (type: string, doc: IRDocument, errors: LogicValidationError[], contextMsg: string, functionId?: string) => {
  if (PRIMITIVE_TYPES.includes(type as any)) return;
  const isStruct = doc.structs?.some(s => s.id === type);
  if (isStruct) return;

  if (type.startsWith('array<')) {
    const match = type.match(/^array<([^,]+),\s*(\d+)?>/);
    if (!match) {
      errors.push({ functionId, message: `${contextMsg}: Invalid array syntax '${type}'. Expected 'array<Type, N>'.`, severity: 'error' });
      return;
    }
    const innerType = match[1].trim();
    validateDataType(innerType, doc, errors, `${contextMsg} (array element)`, functionId);
    return;
  }
  if (type.endsWith('[]')) {
    const innerType = type.substring(0, type.length - 2).trim();
    validateDataType(innerType, doc, errors, `${contextMsg} (array element)`, functionId);
    return;
  }

  errors.push({ functionId, message: `${contextMsg}: Invalid data type '${type}'. Must be a primitive or defined struct.`, severity: 'error' });
};

export const validateResources = (doc: IRDocument, errors: LogicValidationError[]) => {
  (doc.resources || []).forEach(res => {
    // Validate Texture Format
    if (res.type === 'texture2d') {
      const fmt = (res as any).format;
      if (!fmt) {
        errors.push({ message: `Texture resource '${res.id}' missing required 'format' property`, severity: 'error' });
      } else {
        if (!Object.values(TextureFormat).includes(fmt as TextureFormat)) {
          errors.push({ message: `Texture resource '${res.id}' has invalid format '${fmt}'`, severity: 'error' });
        }
      }

      const sampler = (res as any).sampler;
      if (sampler) {
        if (sampler.wrap && !['clamp', 'repeat', 'mirror'].includes(sampler.wrap)) {
          errors.push({ message: `Texture resource '${res.id}' has invalid wrap mode '${sampler.wrap}'`, severity: 'error' });
        }
        if (sampler.filter && !['nearest', 'linear'].includes(sampler.filter)) {
          errors.push({ message: `Texture resource '${res.id}' has invalid filter mode '${sampler.filter}'`, severity: 'error' });
        }
      }
    } else if (res.type === 'buffer') {
      if (!res.dataType) {
        errors.push({ message: `Buffer resource '${res.id}' missing required 'dataType' property`, severity: 'error' });
      } else {
        validateDataType(res.dataType, doc, errors, `Buffer resource '${res.id}'`);
      }
    } else if (res.type === 'atomic_counter') {
      if (res.dataType && res.dataType !== 'int') {
        errors.push({ message: `Atomic counter resource '${res.id}' must have dataType 'int', got '${res.dataType}'`, severity: 'error' });
      }
    }
  });
};

export const validateInputs = (doc: IRDocument, errors: LogicValidationError[]) => {
  (doc.inputs || []).forEach(input => {
    validateDataType(input.type, doc, errors, `Input '${input.id}'`);

    const def = input.default;
    if (def !== undefined) {
      let providedType: string = typeof def;
      if (Array.isArray(def)) {
        if (def.length === 2) providedType = 'float2';
        else if (def.length === 3) providedType = 'float3';
        else if (def.length === 4) providedType = 'float4';
        else if (def.length === 9) providedType = 'float3x3';
        else if (def.length === 16) providedType = 'float4x4';
        else providedType = 'array';
      } else if (providedType === 'number') {
        providedType = 'float';
      } else if (providedType === 'boolean') {
        providedType = 'bool';
      }

      const expected = input.type.toLowerCase();
      const norm = (t: string) => t === 'boolean' ? 'bool' : t;
      const e = norm(expected);
      const p = norm(providedType);

      const isCompat = e === p || (e === 'float' && p === 'int') || (e === 'int' && p === 'float');

      if (!isCompat) {
        errors.push({
          message: `Input '${input.id}' default value type mismatch: expected ${input.type}, got ${typeof def === 'string' ? `"${def}"` : JSON.stringify(def)} (${providedType})`,
          severity: 'error'
        });
      }
    }
  });
};

export const validateStructs = (doc: IRDocument, errors: LogicValidationError[]) => {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const checkStruct = (structId: string) => {
    if (recursionStack.has(structId)) {
      errors.push({ message: `Recursive struct definition detected: Cycle involving '${structId}'`, severity: 'error' });
      return;
    }
    if (visited.has(structId)) return;

    visited.add(structId);
    recursionStack.add(structId);

    const def = (doc.structs || []).find(s => s.id === structId);
    if (def) {
      for (const member of def.members) {
        validateDataType(member.type, doc, errors, `Struct '${structId}' member '${member.name}'`);

        if ((doc.structs || []).some(s => s.id === member.type)) {
          checkStruct(member.type as string);
        }
      }
    }
    recursionStack.delete(structId);
  };

  doc.structs?.forEach(s => checkStruct(s.id));
};

/**
 * Collect all resource IDs referenced by a shader function (and functions it calls).
 */
const collectFunctionResources = (funcId: string, allFunctions: FunctionDef[], visited = new Set<string>()): Set<string> => {
  if (visited.has(funcId)) return new Set();
  visited.add(funcId);
  const func = allFunctions.find(f => f.id === funcId);
  if (!func) return new Set();
  const resources = new Set<string>();
  for (const node of func.nodes) {
    if (node.op === 'resource_get_size' && typeof node['resource'] === 'string') resources.add(node['resource']);
    if ((node.op === 'texture_load' || node.op === 'texture_sample' || node.op === 'texture_store') && typeof node['tex'] === 'string') resources.add(node['tex']);
    if ((node.op === 'buffer_load' || node.op === 'buffer_store') && typeof node['buffer'] === 'string') resources.add(node['buffer']);
    if (node.op === 'call_func' && typeof node['func'] === 'string') {
      collectFunctionResources(node['func'], allFunctions, visited).forEach(r => resources.add(r));
    }
  }
  return resources;
};

const validateFunction = (func: FunctionDef, doc: IRDocument, resourceIds: Set<string>, errors: LogicValidationError[]) => {
  if (!func || !Array.isArray(func.nodes)) {
    errors.push({ functionId: func?.id || 'unknown', message: 'Function definition missing or invalid: nodes array is required', severity: 'error' });
    return;
  }

  // Validate Signatures
  func.inputs.forEach(param => validateDataType(param.type, doc, errors, `Function '${func.id}' input '${param.id}'`, func.id));
  func.outputs.forEach(param => validateDataType(param.type, doc, errors, `Function '${func.id}' output '${param.id}'`, func.id));
  func.localVars.forEach(v => validateDataType(v.type, doc, errors, `Function '${func.id}' variable '${v.id}'`, func.id));
  const edges = reconstructEdges(func, doc);
  const nodeIds = new Set(func.nodes.map(n => n.id));
  const validSources = new Set([
    ...nodeIds,
    ...func.inputs.map(i => i.id),
    ...func.localVars.map(v => v.id),
    ...(doc.inputs || []).map(i => i.id),
    ...(doc.resources || []).map(r => r.id)
  ]);

  edges.forEach(edge => {
    if (!validSources.has(edge.from)) errors.push({ functionId: func.id, message: `Edge source '${edge.from}' not found`, severity: 'error' });
    if (!nodeIds.has(edge.to)) errors.push({ functionId: func.id, message: `Edge target '${edge.to}' not found`, severity: 'error' });
  });

  const cache: TypeCache = new Map();

  // Reject node IDs containing '.' (conflicts with inline swizzle syntax)
  func.nodes.forEach(node => {
    if (node.id.includes('.')) {
      errors.push({ nodeId: node.id, functionId: func.id, message: `Node ID '${node.id}' contains '.', which conflicts with inline swizzle syntax`, severity: 'error' });
    }
  });

  func.nodes.forEach(node => {
    // 1. Literal and Reference Verification
    const verification = verifyLiteralsOrRefsExist(node, doc, func);
    if (!verification.valid) {
      verification.errors.forEach(msg => {
        errors.push({ nodeId: node.id, functionId: func.id, message: msg, severity: 'error' });
      });

    } // End if (!verification.valid)

    // 1.5. Strict Validation for var_get / var_set
    if (node.op === 'var_get' || node.op === 'var_set') {
      const varId = node['var'];
      const isLocal = func.localVars.some(v => v.id === varId);
      const isGlobal = (doc.inputs || []).some(i => i.id === varId);
      // Also check function arguments (inputs)
      const isArg = func.inputs.some(i => i.id === varId);

      if (!isLocal && !isGlobal && !isArg) {
        errors.push({
          nodeId: node.id,
          functionId: func.id,
          message: `Variable '${varId}' is not defined in local scope, function arguments, or as a global input`,
          severity: 'error'
        });
      }
    }

    resolveNodeType(node.id, func, doc, cache, resourceIds, errors, edges);

    if (node.op === 'builtin_get' && func.type === 'cpu') {
      const name = node['name'];
      const isCpuAllowed = BUILTIN_CPU_ALLOWED.includes(name);
      if (!isCpuAllowed) {
        errors.push({
          nodeId: node.id,
          functionId: func.id,
          message: `GPU Built-in '${name}' is not available in CPU context`,
          severity: 'error'
        });
      }
    }

    if (node.op === 'const_get') {
      const name = node.name as string;
      if (!name) return;

      if (name.startsWith('TextureFormat.')) {
        const key = name.split('.')[1];
        if (!(key in TextureFormat)) {
          errors.push({ nodeId: node.id, functionId: func.id, message: `Invalid TextureFormat constant '${name}'`, severity: 'error' });
        }
      } else if (name && !name.includes('.')) {
        errors.push({ nodeId: node.id, functionId: func.id, message: `Invalid constant name '${name}'`, severity: 'error' });
      }
    }

    // Forbidden Ops in Shader Context (CPU-only commands)
    if (func.type !== 'cpu') {
      const opDef = OpDefs[node.op as BuiltinOp];
      if (opDef?.cpuOnly) {
        errors.push({
          nodeId: node.id,
          functionId: func.id,
          message: `Operation '${node.op}' is not allowed in shader functions (must be executed in CPU context)`,
          severity: 'error'
        });
      }
    }

    const opDef = OpDefs[node.op as BuiltinOp];
    if (opDef) {
      let resId: string | undefined;
      // 1. Find primary resource arg via schema
      for (const [key, arg] of Object.entries(opDef.args)) {
        if (arg.isPrimaryResource) {
          resId = node[key];
          if (resId === undefined && node['args']) {
            resId = node['args'][key];
          }
          break;
        }
      }

      if (typeof resId === 'string' && !resourceIds.has(resId)) {
        errors.push({ nodeId: node.id, functionId: func.id, message: `Referenced resource '${resId}' not found`, severity: 'error' });
      } else if (typeof resId === 'string') {
        const resDef = doc.resources?.find(r => r.id === resId);
        const index = node['index'];

        if (resDef && typeof index === 'number') {
          if (index < 0) {
            errors.push({ nodeId: node.id, functionId: func.id, message: `Invalid Negative Index: ${index}`, severity: 'error' });
          }
          if (resDef.size.mode === 'fixed') {
            const sizeVal = resDef.size.value;
            if (typeof sizeVal === 'number') {
              if (index >= sizeVal) {
                errors.push({ nodeId: node.id, functionId: func.id, message: `Static OOB Access: Index ${index} >= Size ${sizeVal}`, severity: 'error' });
              }
            }
          }
        }

        // Validate atomic ops reference atomic_counter resources
        if (node.op.startsWith('atomic_') && resDef) {
          if (resDef.type !== 'atomic_counter') {
            errors.push({
              nodeId: node.id, functionId: func.id,
              message: `Atomic operation '${node.op}' requires an atomic_counter resource, but '${resId}' is a '${resDef.type}'`,
              severity: 'error'
            });
          }
        }

        // Strict Type Check for buffer_store
        if (node.op === 'buffer_store' && resDef) {
          const normalize = (t: string): ValidationType => {
            if (BLITTABLE_TYPES.includes(t)) {
              return t as ValidationType;
            }
            return 'any';
          };

          const expectedType = normalize(resDef.dataType || 'float');

          // Resolve Actual Type
          let actualType: ValidationType = 'any';
          const edge = edges.find(e => e.to === node.id && e.portIn === 'value');
          if (edge) {
            actualType = resolveNodeType(edge.from, func, doc, cache, resourceIds, errors, edges);
          } else if (node['value'] !== undefined) {
            const v = node['value'];
            if (typeof v === 'number') actualType = 'float';
            else if (typeof v === 'boolean') actualType = 'boolean';
            else if (Array.isArray(v)) {
              if (v.length === 2) actualType = 'float2';
              else if (v.length === 3) actualType = 'float3';
              else if (v.length === 4) actualType = 'float4';
              else if (v.length === 9) actualType = 'float3x3';
              else if (v.length === 16) actualType = 'float4x4';
            }
          }

          if (actualType !== 'any' && expectedType !== 'any' && actualType !== expectedType) {
            // Allow int -> float? No, User requested strict check.
            // "strict type casting (e.g. i32 -> f32) in generation" implies implicit is BAD.
            errors.push({
              nodeId: node.id,
              functionId: func.id,
              message: `Type Mismatch in buffer_store: Buffer '${resId}' expects '${expectedType}', got '${actualType}'`,
              severity: 'error'
            });
          }
        }
      }
    }
  });

  // Render target conflict detection for cmd_draw nodes
  if (func.type === 'cpu') {
    func.nodes.forEach(node => {
      if (node.op === 'cmd_draw') {
        const targetId = node['target'] as string;
        const vertexId = node['vertex'] as string;
        const fragmentId = node['fragment'] as string;
        if (!targetId) return;
        const shaderFuncIds = [vertexId, fragmentId].filter(Boolean);
        const referencedResources = new Set<string>();
        for (const fid of shaderFuncIds) {
          collectFunctionResources(fid, doc.functions).forEach(r => referencedResources.add(r));
        }
        if (referencedResources.has(targetId)) {
          errors.push({
            nodeId: node.id,
            functionId: func.id,
            message: `Render target '${targetId}' cannot be accessed as a resource in vertex/fragment shaders. Use 'builtin_get output_size' for dimensions.`,
            severity: 'error'
          });
        }
      }
    });
  }
};
