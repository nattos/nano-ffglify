import { IRDocument, Node, FunctionDef } from './types';
import { OpSignatures, OpSignature, ValidationType } from './signatures';
import { TextureFormat, TextureFormatValues } from './types'; // For const checking if available? Or just values.
// We might not have TextureFormat runtime values here easily without importing execution context stuff,
// but we can mock or replicate keys.
// Actually TextureFormatValues is in types.ts? No, types.ts defines Enum.
// Let's assume we can validate against known strings.

export interface ValidationError {
  nodeId?: string;
  message: string;
  severity: 'error' | 'warning';
}

export const validateIR = (doc: IRDocument): ValidationError[] => {
  const errors: ValidationError[] = [];

  // Global Context for Type Resolution
  const resourceIds = new Set(doc.resources.map(r => r.id));

  doc.functions.forEach(func => {
    validateFunction(func, doc, resourceIds, errors);
  });

  return errors;
};

// ------------------------------------------------------------------
// Type Inference Engine
// ------------------------------------------------------------------
type TypeCache = Map<string, ValidationType>;

const resolveNodeType = (
  nodeId: string,
  func: FunctionDef,
  cache: TypeCache,
  resourceIds: Set<string>,
  errors: ValidationError[]
): ValidationType => {
  if (cache.has(nodeId)) return cache.get(nodeId)!;

  const node = func.nodes.find(n => n.id === nodeId);
  if (!node) return 'any'; // Should have been caught by basic structure check

  const sigs = OpSignatures[node.op as keyof typeof OpSignatures];
  if (!sigs) {
    // Unknown op or no signature defined?
    // Fallback to 'any' but log warning?
    // For compliance tests, we expect validation to know these ops.
    // Returning 'any' prevents cascading errors.
    cache.set(nodeId, 'any');
    return 'any';
  }

  // Resolve Inputs
  const inputTypes: Record<string, ValidationType> = {};

  // Check all possible inputs across all overloads to gather what we have
  // Actually we need to check what Edges/Props are present.
  // Collect all incoming data.
  const incomingEdges = func.edges.filter(e => e.to === nodeId && e.type === 'data');

  // We infer inputs based on what IS connected/set.
  // Then we try to match signatures.

  // 1. Gather Input Types from Edges
  incomingEdges.forEach(edge => {
    const srcType = resolveNodeType(edge.from, func, cache, resourceIds, errors);
    inputTypes[edge.portIn] = srcType;
  });

  // 2. Gather Input Types from Literal Props
  // We scan the Node's own properties.
  // But we don't know which props are args vs metadata?
  // We can check against the Union of all keys in Signatures.
  const potentialKeys = new Set<string>();
  sigs.forEach(sig => Object.keys(sig.inputs).forEach(k => potentialKeys.add(k)));

  potentialKeys.forEach(key => {
    if (inputTypes[key]) return; // Already from edge

    const val = node[key];
    if (val !== undefined) {
      // Literal inference
      if (Array.isArray(val)) {
        if (val.length === 2) inputTypes[key] = 'vec2';
        else if (val.length === 3) inputTypes[key] = 'vec3';
        else if (val.length === 4) inputTypes[key] = 'vec4';
        else if (val.length === 9) inputTypes[key] = 'mat3';
        else if (val.length === 16) inputTypes[key] = 'mat4';
        else inputTypes[key] = 'array';
      } else if (typeof val === 'number') {
        inputTypes[key] = 'number';
      } else if (typeof val === 'boolean') {
        inputTypes[key] = 'boolean';
      } else if (typeof val === 'string') {
        // String literal? OR Node ID ref?
        // In our IR, string value in prop is usually Node ID reference (handled by resolve logic in runtime).
        // But statically, if it matches another Node ID, it's a ref.
        // If it doesn't match, it's a string literal.
        const refNode = func.nodes.find(n => n.id === val);
        if (refNode) {
          // It's a ref, but not connected via edge?
          // The Validator should treat this as a connection?
          // Runtime treats props as fallback refs.
          // Let's resolve the ref type.
          inputTypes[key] = resolveNodeType(val, func, cache, resourceIds, errors);
        } else {
          inputTypes[key] = 'string';
        }
      }
    }
  });

  // 3. Match against Overloads
  let matchedSig: OpSignature | undefined;

  for (const sig of sigs) {
    let match = true;
    for (const [argName, argType] of Object.entries(sig.inputs)) {
      const providedType = inputTypes[argName];

      // Missing required arg
      if (!providedType) {
        match = false;
        break;
      }

      // Type Mismatch
      if (argType !== 'any' && providedType !== 'any' && argType !== providedType) {
        // Check hierarchy? 'int' fits in 'number'?
        // Let's allow int -> number and number -> int (for literals typed as number)
        if ((argType === 'number' && providedType === 'int') ||
          (argType === 'int' && providedType === 'number')) continue;

        match = false;
        break;
      }
    }

    if (match) {
      matchedSig = sig;
      break;
    }
  }

  if (matchedSig) {
    // Special Pass-Through Logic
    if (node.op === 'var_set' && inputTypes['val'] && inputTypes['val'] !== 'any') {
      cache.set(nodeId, inputTypes['val']);
      return inputTypes['val'];
    }

    cache.set(nodeId, matchedSig.output);
    return matchedSig.output;
  }

  // No match found -> Error
  // We construct a specific error message based on why it failed?
  // Determine if it's "Missing Arg" or "Type Mismatch".

  // Pick the first signature as reference?
  const refSig = sigs[0];

  // Check Missing
  for (const reqArg of Object.keys(refSig.inputs)) {
    if (!inputTypes[reqArg]) {
      errors.push({ nodeId, message: `Missing required argument '${reqArg}' for op '${node.op}'`, severity: 'error' });
    }
  }

  // Check Mismatches (against first sig for simplicity of reporting)
  // Ideally we list all overloads?
  for (const [argName, argType] of Object.entries(refSig.inputs)) {
    const providedType = inputTypes[argName];
    if (providedType && argType !== 'any' && providedType !== 'any' && argType !== providedType) {
      if ((argType === 'number' && providedType === 'int') ||
        (argType === 'int' && providedType === 'number')) continue;

      errors.push({
        nodeId,
        message: `Type Mismatch at '${argName}': expected ${argType}, got ${providedType}`,
        severity: 'error'
      });
    }
  }

  cache.set(nodeId, 'any'); // Prevent cascading errors
  return 'any';
};


const validateFunction = (func: FunctionDef, doc: IRDocument, resourceIds: Set<string>, errors: ValidationError[]) => {
  // 1. Basic Edge Integrity
  const nodeIds = new Set(func.nodes.map(n => n.id));
  func.edges.forEach(edge => {
    if (!nodeIds.has(edge.from)) errors.push({ message: `Edge source '${edge.from}' not found`, severity: 'error' });
    if (!nodeIds.has(edge.to)) errors.push({ message: `Edge target '${edge.to}' not found`, severity: 'error' });
  });

  // 2. Resolve Types & Check Defs
  const cache: TypeCache = new Map();

  func.nodes.forEach(node => {
    // Trigger resolution which accumulates errors
    resolveNodeType(node.id, func, cache, resourceIds, errors);

    // Specific semantic checks
    if (node.op === 'struct_extract') {
      // Already checked type is 'struct' via signature.
    }

    // ----------------------------------------------------------------
    // CONSTANT & ENUM VALIDATION
    // ----------------------------------------------------------------
    if (node.op === 'const_get') {
      const name = node.name as string;
      if (!name) return; // Signature handles missing

      // TextureFormat Validation
      if (name.startsWith('TextureFormat.')) {
        const key = name.split('.')[1];
        if (!Object.keys(TextureFormatValues).some(k => k === key || TextureFormat[k as keyof typeof TextureFormat] === key)) {
          // We check against the keys of the Enum or Values?
          // TextureFormat struct in types: enum TextureFormat { RGBA8 = 'rgba8' ... }
          // We want "TextureFormat.RGBA8".
          // Object.keys(TextureFormat) gives 'RGBA8', 'R8'...
          if (!(key in TextureFormat)) {
            errors.push({ nodeId: node.id, message: `Invalid TextureFormat constant '${name}'`, severity: 'error' });
          }
        }
      } else if (name && !name.includes('.')) {
        errors.push({ nodeId: node.id, message: `Invalid constant name '${name}'`, severity: 'error' });
      }
    }

    if (node.op === 'cmd_resize_resource') {
      // Check 'format' arg if literal
      const fmt = node['format'];
      if (fmt !== undefined) {
        if (typeof fmt === 'string') {
          // Enum Value String 'rgba8', etc.
          const valid = Object.values(TextureFormat).includes(fmt as TextureFormat);
          if (!valid) {
            errors.push({ nodeId: node.id, message: `Invalid TextureFormat value '${fmt}'`, severity: 'error' });
          }
        } else if (typeof fmt === 'number') {
          // ID check
          if (!Object.values(TextureFormatValues).includes(fmt)) {
            errors.push({ nodeId: node.id, message: `Invalid TextureFormat ID '${fmt}'`, severity: 'error' });
          }
        }
      }
    }

    // ----------------------------------------------------------------
    // RESOURCE & RANGE VALIDATION
    // ----------------------------------------------------------------
    if (node.op.startsWith('buffer_') || node.op.startsWith('texture_') || node.op === 'cmd_resize_resource') {
      const resId = node['buffer'] || node['tex'] || node['resource'];
      if (typeof resId === 'string' && !resourceIds.has(resId)) {
        errors.push({ nodeId: node.id, message: `Referenced resource '${resId}' not found`, severity: 'error' });
      } else if (typeof resId === 'string') {
        // Resource Exists. Check Access Bounds if literal index.
        const resDef = doc.resources.find(r => r.id === resId);
        const index = node['index'];

        if (resDef && typeof index === 'number') {
          // Negative Index Check
          if (index < 0) {
            errors.push({ nodeId: node.id, message: `Invalid Negative Index: ${index}`, severity: 'error' });
          }

          // Fixed Size OOB Check
          if (resDef.size.mode === 'fixed') {
            // Fixed 1D or 2D?
            // buffer_store/load typically 1D index on standard buffer.
            // If buffer is 1D (value is number)
            const sizeVal = resDef.size.value;
            if (typeof sizeVal === 'number') {
              if (index >= sizeVal) {
                errors.push({ nodeId: node.id, message: `Static OOB Access: Index ${index} >= Size ${sizeVal}`, severity: 'error' });
              }
            }
            // If 2D ([w, h]), index usually means linear or we need coord?
            // buffer ops usually 1D. If target is texture, buffer_store might fail or overwrite raw?
            // For now, assume 1D buffer size check.
          }
        }
      }
    }
  });
};
