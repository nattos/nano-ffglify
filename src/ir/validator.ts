import { IRDocument, FunctionDef, BuiltinOp } from './types';
import { OpSignatures, OpSignature, ValidationType } from './signatures';
import { OpSchemas } from './builtin-schemas';
import { verifyLiteralsOrRefsExist } from './schema-verifier';

import { TextureFormat, TextureFormatValues, PRIMITIVE_TYPES } from './types';

// Local Error Type (Internal to logic validator, mapped by schema.ts)
export interface LogicValidationError {
  nodeId?: string;
  message: string;
  severity: 'error' | 'warning';
}

export const validateStaticLogic = (doc: IRDocument): LogicValidationError[] => {
  const errors: LogicValidationError[] = [];

  // Global Context for Type Resolution
  const resourceIds = new Set([
    ...doc.resources.map(r => r.id),
    ...doc.inputs.map(i => i.id)
  ]);

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
    ...ir.resources.map(r => r.id),
    ...ir.inputs.map(i => i.id)
  ]);
  const cache: InferredTypes = new Map();
  const errors: LogicValidationError[] = [];
  func.nodes.forEach(node => {
    resolveNodeType(node.id, func, ir, cache, resourceIds, errors);
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
  errors: LogicValidationError[]
): ValidationType => {
  if (cache.has(nodeId)) return cache.get(nodeId)!;

  // Sentinel to break recursion cycles
  cache.set(nodeId, 'any');

  const node = func.nodes.find(n => n.id === nodeId);
  if (!node) return 'any';

  // console.log(`[Validator] Resolving ${node.id} (${node.op})`);

  const sigs = OpSignatures[node.op as keyof typeof OpSignatures];
  if (!sigs) {
    // console.log(`[Validator] No signatures found for op ${node.op}`);
    cache.set(nodeId, 'any');
    return 'any';
  }

  // Resolve Inputs
  const inputTypes: Record<string, ValidationType> = {};

  // 1. Gather Input Types from Edges
  const incomingEdges = func.edges.filter(e => e.to === nodeId && e.type === 'data');
  incomingEdges.forEach(edge => {
    const srcType = resolveNodeType(edge.from, func, doc, cache, resourceIds, errors);
    inputTypes[edge.portIn] = srcType;
  });

  // 2. Gather Input Types from Literal Props
  const reservedKeys = new Set(['id', 'op', 'metadata', 'const_data']);
  Object.keys(node).forEach(key => {
    if (reservedKeys.has(key)) return;
    if (inputTypes[key]) return; // Already from edge

    const val = node[key];
    if (val !== undefined) {
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
        const refGlobal = doc.inputs.find(i => i.id === val);

        // Properties that are NAMES, not DATA references
        const nameProperties = ['var', 'buffer', 'tex', 'resource', 'field', 'loop', 'name', 'func'];
        const isNameProperty = nameProperties.includes(key);

        if (refNode && !isNameProperty) {
          inputTypes[key] = resolveNodeType(val, func, doc, cache, resourceIds, errors);
        } else if (refInput && !isNameProperty) {
          inputTypes[key] = refInput.type as ValidationType;
        } else if (refGlobal && !isNameProperty) {
          inputTypes[key] = refGlobal.type as ValidationType;
        } else {
          inputTypes[key] = 'string';
        }
      }
    }
  });

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
    for (const [argName, argType] of Object.entries(sig.inputs)) {
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
      const extraKeys = Object.keys(inputTypes).filter(k => !(k in sig.inputs));
      if (extraKeys.length > 0) {
        errors.push({
          nodeId,
          message: `Unknown argument(s) '${extraKeys.join(', ')}' for op '${node.op}'`,
          severity: 'error'
        });
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

    // Vec Swizzle Logic
    if (node.op === 'vec_swizzle') {
      const inputType = inputTypes['vec'];
      const mask = node['channels'];

      if (typeof mask !== 'string') {
        errors.push({ nodeId, message: 'Swizzle mask must be a string literal', severity: 'error' });
        cache.set(nodeId, 'any'); return 'any';
      }

      const validComps = ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a'];
      if (mask.length < 1 || mask.length > 4) {
        errors.push({ nodeId, message: `Invalid swizzle mask length '${mask}'`, severity: 'error' });
      }

      let maxComp = 0;
      if (inputType === 'float2') maxComp = 2;
      else if (inputType === 'float3') maxComp = 3;
      else if (inputType === 'float4') maxComp = 4;

      if (maxComp > 0) {
        for (const char of mask) {
          const idx = validComps.indexOf(char);
          if (idx === -1) {
            errors.push({ nodeId, message: `Invalid swizzle component '${char}'`, severity: 'error' });
          } else {
            const effectiveIdx = idx % 4;
            if (effectiveIdx >= maxComp) {
              errors.push({ nodeId, message: `Swizzle component '${char}' out of bounds for ${inputType}`, severity: 'error' });
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
  for (const reqArg of Object.keys(refSig.inputs)) {
    if (!inputTypes[reqArg]) {
      errors.push({ nodeId, message: `Missing required argument '${reqArg}' for op '${node.op}'`, severity: 'error' });
    }
  }
  for (const [argName, argType] of Object.entries(refSig.inputs)) {
    const providedType = inputTypes[argName];
    if (providedType && argType !== 'any' && providedType !== 'any' && argType !== providedType) {
      if ((argType === 'float' && providedType === 'int') ||
        (argType === 'int' && providedType === 'float')) continue;
      errors.push({ nodeId, message: `Type Mismatch at '${argName}': expected ${argType}, got ${providedType}`, severity: 'error' });
    }
  }

  cache.set(nodeId, 'any');
  return 'any';
};

const validateDataType = (type: string, doc: IRDocument, errors: LogicValidationError[], contextMsg: string) => {
  if (['float', 'int', 'bool', 'float2', 'float3', 'float4', 'float3x3', 'float4x4', 'texture2d', 'sampler'].includes(type as any)) return;
  const isStruct = doc.structs?.some(s => s.id === type);
  if (isStruct) return;

  if (type.startsWith('array<')) return;
  if (type.endsWith('[]')) return;

  errors.push({ message: `${contextMsg}: Invalid data type '${type}'. Must be a primitive or defined struct.`, severity: 'error' });
};

export const validateResources = (doc: IRDocument, errors: LogicValidationError[]) => {
  doc.resources.forEach(res => {
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
  doc.inputs.forEach(input => {
    validateDataType(input.type, doc, errors, `Input '${input.id}'`);
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
  func.inputs.forEach(param => validateDataType(param.type, doc, errors, `Function '${func.id}' input '${param.id}'`));
  func.outputs.forEach(param => validateDataType(param.type, doc, errors, `Function '${func.id}' output '${param.id}'`));
  func.localVars.forEach(v => validateDataType(v.type, doc, errors, `Function '${func.id}' variable '${v.id}'`));
  const nodeIds = new Set(func.nodes.map(n => n.id));
  func.edges.forEach(edge => {
    if (!nodeIds.has(edge.from)) errors.push({ message: `Edge source '${edge.from}' not found`, severity: 'error' });
    if (!nodeIds.has(edge.to)) errors.push({ message: `Edge target '${edge.to}' not found`, severity: 'error' });
  });

  const cache: TypeCache = new Map();

  func.nodes.forEach(node => {
    // 1. Literal and Reference Verification
    const verification = verifyLiteralsOrRefsExist(node, doc, func);
    if (!verification.valid) {
      verification.errors.forEach(msg => {
        errors.push({ nodeId: node.id, message: msg, severity: 'error' });
      });
    }

    resolveNodeType(node.id, func, doc, cache, resourceIds, errors);

    if (node.op === 'builtin_get' && func.type === 'cpu') {
      errors.push({
        nodeId: node.id,
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
          errors.push({ nodeId: node.id, message: `Invalid TextureFormat constant '${name}'`, severity: 'error' });
        }
      } else if (name && !name.includes('.')) {
        errors.push({ nodeId: node.id, message: `Invalid constant name '${name}'`, severity: 'error' });
      }
    }



    if (node.op.startsWith('buffer_') || node.op.startsWith('texture_') || node.op === 'cmd_resize_resource') {
      const resId = node['buffer'] || node['tex'] || node['resource'];
      if (typeof resId === 'string' && !resourceIds.has(resId)) {
        errors.push({ nodeId: node.id, message: `Referenced resource '${resId}' not found`, severity: 'error' });
      } else if (typeof resId === 'string') {
        const resDef = doc.resources.find(r => r.id === resId);
        const index = node['index'];

        if (resDef && typeof index === 'number') {
          if (index < 0) {
            errors.push({ nodeId: node.id, message: `Invalid Negative Index: ${index}`, severity: 'error' });
          }
          if (resDef.size.mode === 'fixed') {
            const sizeVal = resDef.size.value;
            if (typeof sizeVal === 'number') {
              if (index >= sizeVal) {
                errors.push({ nodeId: node.id, message: `Static OOB Access: Index ${index} >= Size ${sizeVal}`, severity: 'error' });
              }
            }
          }
        }

        // Strict Type Check for buffer_store
        if (node.op === 'buffer_store' && resDef) {
          const normalize = (t: string): ValidationType => {
            if (t === 'f32' || t === 'float') return 'float';
            if (t === 'i32' || t === 'int') return 'int';
            if (t === 'bool' || t === 'boolean') return 'boolean';
            if (t === 'vec2<f32>' || t === 'float2') return 'float2';
            if (t === 'vec3<f32>' || t === 'float3') return 'float3';
            if (t === 'vec4<f32>' || t === 'float4') return 'float4';
            if (t === 'mat3x3<f32>' || t === 'float3x3') return 'float3x3';
            if (t === 'mat4x4<f32>' || t === 'float4x4') return 'float4x4';
            return 'any';
          };

          const expectedType = normalize(resDef.dataType || 'float');

          // Resolve Actual Type
          let actualType: ValidationType = 'any';
          const edge = func.edges.find(e => e.to === node.id && e.portIn === 'value');
          if (edge) {
            actualType = resolveNodeType(edge.from, func, doc, cache, resourceIds, errors);
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
              message: `Type Mismatch in buffer_store: Buffer '${resId}' expects '${expectedType}', got '${actualType}'`,
              severity: 'error'
            });
          }
        }
      }
    }
  });
};
