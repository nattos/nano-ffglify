import { z } from 'zod';
import { IRDocument, DataType } from './types.js';

// ------------------------------------------------------------------
// Validation Types
// ------------------------------------------------------------------

export interface ValidationError {
  path: string[];
  message: string;
  code: string;
}

export type ValidationResult =
  | { success: true; data: IRDocument }
  | { success: false; errors: ValidationError[] };

// ------------------------------------------------------------------
// Zod Schemas
// ------------------------------------------------------------------

// Enums
const DataTypeSchema = z.enum([
  'float', 'int', 'bool',
  'vec2', 'vec3', 'vec4',
  'mat3', 'mat4',
  'color', 'string',
  'texture2d', 'sampler'
]);

const ResourceTypeSchema = z.enum(['texture2d', 'buffer', 'atomic_counter']);
const FunctionTypeSchema = z.enum(['cpu', 'shader']);
const EdgeTypeSchema = z.enum(['data', 'execution']);

// Meta
const MetaDataSchema = z.object({
  name: z.string(),
  author: z.string().optional(),
  description: z.string().optional(),
  license: z.string().optional(),
});

// Inputs
const InputDefSchema = z.object({
  id: z.string(),
  type: DataTypeSchema,
  label: z.string().optional(),
  default: z.any().optional(),
  ui: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    widget: z.enum(['slider', 'color_picker', 'text', 'toggle', 'file']).optional(),
  }).optional(),
});

// Resources
const ResourceSizeSchema = z.union([
  z.object({ mode: z.literal('fixed'), value: z.union([z.number(), z.tuple([z.number(), z.number()])]) }),
  z.object({ mode: z.literal('viewport'), scale: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional() }),
  z.object({ mode: z.literal('reference'), ref: z.string() }),
  z.object({ mode: z.literal('cpu_driven') }),
]);

const ResourceDefSchema = z.object({
  id: z.string(),
  type: ResourceTypeSchema,
  dataType: DataTypeSchema.optional(),
  structType: z.array(z.object({ name: z.string(), type: DataTypeSchema })).optional(),
  size: ResourceSizeSchema,
  persistence: z.object({
    retain: z.boolean(),
    clearOnResize: z.boolean(),
    clearEveryFrame: z.boolean(),
    clearValue: z.any().optional(),
    cpuAccess: z.boolean(),
  }),
});

// Functions & Graph
const VariableDefSchema = z.object({
  id: z.string(),
  type: DataTypeSchema,
  initialValue: z.any().optional(),
});

const PortDefSchema = z.object({
  id: z.string(),
  type: DataTypeSchema,
});

const NodeSchema = z.object({
  id: z.string(),
  op: z.string(),
  const_data: z.any().optional(),
  metadata: z.object({
    x: z.number(),
    y: z.number(),
    label: z.string().optional(),
  }).optional(),
}).passthrough(); // Allow op-specific args

const EdgeSchema = z.object({
  from: z.string(),
  portOut: z.string(),
  to: z.string(),
  portIn: z.string(),
  type: EdgeTypeSchema,
});

const FunctionDefSchema = z.object({
  id: z.string(),
  type: FunctionTypeSchema,
  inputs: z.array(PortDefSchema),
  outputs: z.array(PortDefSchema),
  localVars: z.array(VariableDefSchema),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

// Root
export const IRDocumentSchema = z.object({
  version: z.string(),
  meta: MetaDataSchema,
  entryPoint: z.string(),
  inputs: z.array(InputDefSchema),
  resources: z.array(ResourceDefSchema),
  functions: z.array(FunctionDefSchema),
});

// ------------------------------------------------------------------
// Validator Function
// ------------------------------------------------------------------

export function validateIR(json: unknown): ValidationResult {
  const result = IRDocumentSchema.safeParse(json);

  // 1. Structural Validation (Zod)
  if (!result.success) {
    const errors: ValidationError[] = result.error.issues.map(err => ({
      path: err.path.map(String),
      message: err.message,
      code: err.code
    }));
    return { success: false, errors };
  }

  const doc = result.data as IRDocument;
  const semanticErrors: ValidationError[] = [];

  // 2. Semantic Validation

  // 2. Semantic Validation

  // Indexing Context & Global Duplicates Check
  const functionIds = new Set<string>();
  const resourceIds = new Set<string>();
  const inputIds = new Set<string>();

  // Check Duplicates: Inputs
  doc.inputs.forEach((i, idx) => {
    if (inputIds.has(i.id)) {
      semanticErrors.push({
        path: ['inputs', idx.toString(), 'id'],
        message: `Duplicate Input ID '${i.id}'.`,
        code: 'semantic_error'
      });
    }
    inputIds.add(i.id);
  });

  // Check Duplicates: Resources
  doc.resources.forEach((r, idx) => {
    if (resourceIds.has(r.id)) {
      semanticErrors.push({
        path: ['resources', idx.toString(), 'id'],
        message: `Duplicate Resource ID '${r.id}'.`,
        code: 'semantic_error'
      });
    }
    resourceIds.add(r.id);
  });

  // Check Duplicates: Functions
  doc.functions.forEach((f, idx) => {
    if (functionIds.has(f.id)) {
      semanticErrors.push({
        path: ['functions', idx.toString(), 'id'],
        message: `Duplicate Function ID '${f.id}'.`,
        code: 'semantic_error'
      });
    }
    functionIds.add(f.id);
  });

  const allGlobalIds = new Set([...resourceIds, ...inputIds]);

  // A. Check Entry Point
  if (!functionIds.has(doc.entryPoint)) {
    semanticErrors.push({
      path: ['entryPoint'],
      message: `Entry Point function '${doc.entryPoint}' not found definition.`,
      code: 'semantic_error'
    });
  } else {
    // Check entry point is CPU
    const entryFunc = doc.functions.find(f => f.id === doc.entryPoint);
    if (entryFunc && entryFunc.type !== 'cpu') {
      semanticErrors.push({
        path: ['entryPoint'],
        message: `Entry Point function '${doc.entryPoint}' must be of type 'cpu'.`,
        code: 'semantic_error'
      });
    }
  }

  // B. Iterate Functions
  doc.functions.forEach((func, fIdx) => {
    const nodeIds = new Set<string>();

    // Check Duplicate Node IDs
    func.nodes.forEach((node, nIdx) => {
      if (nodeIds.has(node.id)) {
        semanticErrors.push({
          path: ['functions', fIdx.toString(), 'nodes', nIdx.toString(), 'id'],
          message: `Duplicate Node ID '${node.id}' in function '${func.id}'.`,
          code: 'semantic_error'
        });
      }
      nodeIds.add(node.id);

      // C. Check Resource References in Nodes
      // Heuristic: Check common fields 'resource', 'buffer', 'tex', 'texture'
      const potentialRefFields = ['resource', 'buffer', 'tex', 'texture'];

      for (const field of potentialRefFields) {
        if (typeof node[field] === 'string') {
          const refId = node[field];
          if (!allGlobalIds.has(refId)) {
            // Exceptions: local variables? No, variables are accessed via 'var_get' using 'var' field usually.
            // But let's check if it matches a valid resource/input
            semanticErrors.push({
              path: ['functions', fIdx.toString(), 'nodes', nIdx.toString(), field],
              message: `Node '${node.id}' references unknown resource '${refId}' in field '${field}'.`,
              code: 'semantic_error'
            });
          }
        }
      }

      // Check 'var' references (local variables)
      if (typeof node['var'] === 'string') {
        const varId = node['var'];
        const localVar = func.localVars.find(v => v.id === varId);
        if (!localVar) {
          semanticErrors.push({
            path: ['functions', fIdx.toString(), 'nodes', nIdx.toString(), 'var'],
            message: `Node '${node.id}' references unknown local variable '${varId}'.`,
            code: 'semantic_error'
          });
        }
      }

      // Check 'func' references (call_func, cmd_dispatch)
      if (typeof node['func'] === 'string') {
        const funcId = node['func'];
        if (!functionIds.has(funcId)) {
          semanticErrors.push({
            path: ['functions', fIdx.toString(), 'nodes', nIdx.toString(), 'func'],
            message: `Node '${node.id}' references unknown function '${funcId}'.`,
            code: 'semantic_error'
          });
        }
      }
    });

    // D. Check Edges
    func.edges.forEach((edge, eIdx) => {
      if (!nodeIds.has(edge.from)) {
        semanticErrors.push({
          path: ['functions', fIdx.toString(), 'edges', eIdx.toString(), 'from'],
          message: `Edge references unknown source node '${edge.from}' in function '${func.id}'.`,
          code: 'semantic_error'
        });
      }
      if (!nodeIds.has(edge.to)) {
        semanticErrors.push({
          path: ['functions', fIdx.toString(), 'edges', eIdx.toString(), 'to'],
          message: `Edge references unknown target node '${edge.to}' in function '${func.id}'.`,
          code: 'semantic_error'
        });
      }
    });

  });

  if (semanticErrors.length > 0) {
    return { success: false, errors: semanticErrors };
  }

  return { success: true, data: doc };
}
