import { IRDocument, FunctionDef, BuiltinOp, BLITTABLE_TYPES } from './types';
import { OpSignatures, OpSignature, ValidationType } from './signatures';
import { OpSchemas, OpDefs } from './builtin-schemas';
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

export const inferFunctionTypes = (func: FunctionDef, ir: IRDocument): InferredTypes => {
  const resourceIds = new Set([
    ...(ir.resources || []).map(r => r.id),
    ...(ir.inputs || []).map(i => i.id)
  ]);
  const cache: InferredTypes = new Map();
  const errors: LogicValidationError[] = [];
  const edges = reconstructEdges(func, ir);
  func.nodes.forEach(node => {
    resolveNodeType(node.id, func, ir, cache, resourceIds, errors, edges);
  });
  return cache;
};

export const validateIR = (doc: IRDocument): LogicValidationError[] => {
  return validateStaticLogic(doc);
};

// ------------------------------------------------------------------
// Type Inference Engine
// ------------------------------------------------------------------
type TypeCache = Map<string, ValidationType>;

export type InferredTypes = Map<string, ValidationType>;

const resolveNodeType = (
  nodeId: string,
  func: FunctionDef,
  doc: IRDocument,
  cache: TypeCache,
  resourceIds: Set<string>,
  errors: LogicValidationError[],
  edges: Edge[]
): ValidationType => {
  const functionId = func.id;
  if (cache.has(nodeId)) return cache.get(nodeId)!;

  // Sentinel to break recursion cycles
  cache.set(nodeId, 'any');

  const node = func.nodes.find(n => n.id === nodeId);
  if (!node) return 'any';

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
    const srcType = resolveNodeType(edge.from, func, doc, cache, resourceIds, errors, edges);
    const port = edge.portIn;
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
      const refNode = func.nodes.find(n => n.id === val);
      const refInput = func.inputs.find(i => i.id === val);
      const refGlobal = doc.inputs?.find(i => i.id === val);

      const def = OpDefs[node.op as BuiltinOp];
      const isNameProperty = def?.args[key]?.isIdentifier ?? false;

      if (refNode && !isNameProperty) {
        inputTypes[key] = resolveNodeType(val, func, doc, cache, resourceIds, errors, edges);
      } else if (refInput && !isNameProperty) {
        inputTypes[key] = refInput.type as ValidationType;
      } else if (refGlobal && !isNameProperty) {
        inputTypes[key] = refGlobal.type as ValidationType;
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

  let matchedSig: OpSignature | undefined;

  for (const sig of sigs) {
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
        if ((argType === 'float' && providedType === 'int') ||
          (argType === 'int' && providedType === 'float')) continue;

        match = false;
        break;
      }
    }

    if (match) {
      // Arity Check
      const extraKeys = Object.keys(inputTypes).filter(k => !(k in sig.inputs) && !hasWildcard);
      if (extraKeys.length > 0) {
        // Not a match, try next signature
        continue;
      }
      matchedSig = sig;
      break;
    }
  }

  if (matchedSig) {
    if (node.op === 'var_set' && inputTypes['val'] && inputTypes['val'] !== 'any') {
      cache.set(nodeId, inputTypes['val']);
      return inputTypes['val'];
    }

    if (node.op === 'literal') {
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

    if (node.op === 'array_construct') {
      const type = node['type'] || 'float';
      let len = 0;
      if (Array.isArray(node['values'])) len = node['values'].length;
      else if (typeof node['length'] === 'number') len = node['length'];

      // Normalize internal type names to WGSL types for the string
      let scalarType = type;
      if (type === 'float') scalarType = 'f32';
      else if (type === 'int' || type === 'i32') scalarType = 'i32';
      else if (type === 'uint' || type === 'u32') scalarType = 'u32';
      else if (type === 'bool' || type === 'boolean') scalarType = 'bool';

      // Special case: Float arrays of length 2/3/4 are vectors in our signatures
      if (scalarType === 'f32') {
        if (len === 2) { cache.set(nodeId, 'float2'); return 'float2'; }
        if (len === 3) { cache.set(nodeId, 'float3'); return 'float3'; }
        if (len === 4) { cache.set(nodeId, 'float4'); return 'float4'; }
      }

      const arrayType = `array<${scalarType}, ${len}>`;
      cache.set(nodeId, arrayType);
      return arrayType;
    }

    if (node.op === 'var_get') {
      const varId = node['var'];
      const localVar = func.localVars.find(v => v.id === varId);
      const globalVar = doc.inputs?.find(i => i.id === varId);
      const type = localVar?.type || globalVar?.type || 'float';
      const vType = type === 'f32' ? 'float' : (type === 'i32' || type === 'int' ? 'int' : type as ValidationType);
      cache.set(nodeId, vType);
      return vType;
    }

    if (node.op === 'buffer_load') {
      const resId = node['buffer'];
      const resDef = doc.resources?.find(r => r.id === resId);
      const type = resDef?.dataType || 'float';
      const vType = type === 'f32' ? 'float' : (type === 'i32' || type === 'int' ? 'int' : type as ValidationType);
      cache.set(nodeId, vType);
      return vType;
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
      if (inputType === 'float2') maxComp = 2;
      else if (inputType === 'float3') maxComp = 3;
      else if (inputType === 'float4') maxComp = 4;

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
        const outType = mask.length === 1 ? 'float' : `float${mask.length}` as ValidationType;
        cache.set(nodeId, outType);
        return outType;
      }
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

  if (type.startsWith('array<')) return;
  if (type.endsWith('[]')) return;

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

const validateFunction = (func: FunctionDef, doc: IRDocument, resourceIds: Set<string>, errors: LogicValidationError[]) => {
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
      errors.push({
        nodeId: node.id,
        functionId: func.id,
        message: `GPU Built-in '${node['name']}' is not available in CPU context`,
        severity: 'error'
      });
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
};
