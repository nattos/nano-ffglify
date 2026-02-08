/**
 * @file types.ts
 * @description Defines the core data model (Entities) and their relationships.
 * This is a "Blueprint" file that should be customized for each specific app.
 *
 * @external-interactions
 * - Uses `schemas.ts` (via `defineSchema`) to create verifiable LLM tool definitions.
 * - Used by `state.ts` to define the shape of the database.
 */
import { defineSchema } from './schemas';
import { IRDocument as BaseIRDocument, PRIMITIVE_TYPES } from '../ir/types';
import { LogicValidationError } from '../ir/validator';
import { BuiltinNameSchema } from '../ir/builtin-schemas';

export type IRDocument = BaseIRDocument;

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ChatMsg {
  id: string; // UUID
  role: 'user' | 'tool-response' | 'assistant';
  text?: string;
  type?: 'text' | 'entity_update';
  data?: any;
}

export interface AppSettings {
  activeTab: 'live' | 'ir' | 'raw_code' | 'state' | 'script' | 'logs';
  chatOpen: boolean;
  useMockLLM: boolean;
  transportState?: 'playing' | 'paused' | 'stopped';
}

export interface LLMLogEntry {
  id: string;
  timestamp: number;
  duration_ms: number;
  turn_index?: number;
  system_instruction_snapshot?: string;
  type: 'chat' | 'tool_call' | 'error';
  prompt_snapshot: string;
  response_snapshot: string;
  tools_called?: string[];
  mocked?: boolean;
}

export interface LocalState {
  settings: AppSettings;
  llmLogs: LLMLogEntry[];
  draftChat: string;
  activeRewindId: string | null;
  selectedEntity?: { id: string; type: 'IR' };
  selectionHistory: { id: string; type: 'IR' }[]; // Back stack
  selectionFuture: { id: string; type: 'IR' }[]; // Forward stack

  validationErrors: LogicValidationError[];
  compilationResult?: {
    js: string;
    jsInit: string;
    wgsl: Record<string, string>;
  };
}

export interface DatabaseState {
  ir: IRDocument;
  chat_history: ChatMsg[];
}

export interface EphemeralState {
  validationErrors: LogicValidationError[];
}

export interface CombinedAgentState {
  database: DatabaseState;
  ephemeral: EphemeralState;
}

// Utility Types
export const IRSchema = defineSchema<IRDocument>({
  name: 'IR',
  description: 'The Intermediate Representation document of the shader graph.',
  fields: {
    version: { type: 'string', description: 'IR Version', required: true },
    meta: {
      type: 'object',
      description: 'Metadata about the document',
      required: true,
      properties: {
        name: { type: 'string', description: 'Name of the shader', required: true },
        author: { type: 'string', description: 'Author name', required: false },
        description: { type: 'string', description: 'Detailed description', required: false },
        license: { type: 'string', description: 'License type', required: false },
        debug: { type: 'boolean', description: 'Enable debug mode', required: false }
      }
    },
    entryPoint: { type: 'string', description: 'ID of the root CPU function', required: true },
    inputs: {
      type: 'array',
      description: 'Global inputs (uniforms)',
      required: false,
      items: {
        type: 'object',
        description: 'Input definition',
        properties: {
          id: { type: 'string', description: 'Variable name', required: true },
          type: { type: 'string', description: 'Data type', required: true },
          label: { type: 'string', description: 'UI Label', required: false },
          comment: { type: 'string', description: 'Description', required: false },
          format: { type: 'string', description: 'Format hint', required: false },
          default: { type: 'any_value', description: 'Default value', required: false },
          ui: {
            type: 'object', description: 'UI Hint', required: false, properties: {
              min: { type: 'number', description: 'Minimum value', required: false },
              max: { type: 'number', description: 'Maximum value', required: false },
              widget: { type: 'string', description: 'Widget type', enum: ['slider', 'color_picker', 'text', 'toggle', 'file'], required: false }
            }
          }
        }
      }
    },
    resources: {
      type: 'array',
      description: 'Resource definitions (buffers/textures)',
      required: false,
      items: {
        type: 'object',
        description: 'Resource definition',
        properties: {
          id: { type: 'string', description: 'Resource ID', required: true },
          type: { type: 'string', description: 'buffer or texture2d', required: true },
          comment: { type: 'string', description: 'Description', required: false },
          dataType: { type: 'string', description: 'Data type (for buffers)', required: false },
          format: { type: 'string', description: 'Pixel format (for textures)', required: false },
          size: {
            type: 'object',
            description: 'Sizing strategy',
            required: true,
            properties: {
              mode: { type: 'string', description: 'fixed, viewport, reference, or cpu_driven', required: true },
              value: { type: 'number', description: 'Fixed size value', required: false },
              scale: { type: 'number', description: 'Viewport scale', required: false },
              ref: { type: 'string', description: 'Reference ID', required: false }
            }
          } as any,
          isOutput: { type: 'boolean', description: 'Explicitly mark as an output. The first texture output will be the main output shown in the UI.', required: false },
          persistence: {
            type: 'object',
            description: 'Lifecycle rules',
            required: true,
            properties: {
              retain: { type: 'boolean', description: 'Retain data across frames', required: true },
              clearOnResize: { type: 'boolean', description: 'Clear on resize', required: true },
              clearEveryFrame: { type: 'boolean', description: 'Clear every frame', required: true },
              cpuAccess: { type: 'boolean', description: 'Allow CPU access', required: true },
              clearValue: { type: 'any_value', description: 'Value to clear to', required: false }
            }
          },
          sampler: {
            type: 'object',
            description: 'Sampling params',
            required: false,
            properties: {
              filter: { type: 'string', description: 'nearest or linear', required: true },
              wrap: { type: 'string', description: 'clamp, repeat, or mirror', required: true }
            }
          },
          structType: {
            type: 'array',
            description: 'Custom layout members (for buffers)',
            required: false,
            items: {
              type: 'object',
              description: 'Member',
              properties: {
                name: { type: 'string', description: 'Member name', required: true },
                type: { type: 'string', description: 'Data type', required: true, enum: [...PRIMITIVE_TYPES] as string[] },
                comment: { type: 'string', description: 'Description', required: false },
                builtin: { type: 'string', description: 'Builtin annotation', required: false, enum: BuiltinNameSchema.options as string[] },
                location: { type: 'number', description: 'Location index', required: false }
              }
            }
          }
        }
      }
    },
    globals: {
      type: 'array',
      description: 'Global data values',
      required: false,
      items: { type: 'object', description: 'Global value', properties: {} } as any
    },
    structs: {
      type: 'array',
      description: 'Shared struct definitions',
      required: false,
      items: {
        type: 'object',
        description: 'Struct definition',
        properties: {
          id: { type: 'string', description: 'Name of custom data type, which can be used to reference this struct for resources and variables etc. Structs can contain other structs this way as well.', required: true },
          members: {
            type: 'array',
            description: 'Members',
            required: true,
            items: {
              type: 'object',
              description: 'Member',
              properties: {
                name: { type: 'string', description: 'Member name', required: true },
                type: { type: 'string', description: 'Data type', required: true, enum: [...PRIMITIVE_TYPES] as string[] },
                comment: { type: 'string', description: 'Description', required: false },
                builtin: { type: 'string', description: 'Builtin annotation', required: false, enum: BuiltinNameSchema.options as string[] },
                location: { type: 'number', description: 'Location index', required: false }
              }
            }
          },
          comment: { type: 'string', description: 'Description', required: false }
        }
      }
    },
    functions: {
      type: 'array',
      description: 'Function definitions',
      required: true,
      items: {
        type: 'object',
        description: 'Function definition',
        properties: {
          id: { type: 'string', description: 'Unique ID', required: true },
          type: { type: 'string', description: 'cpu or shader', required: true },
          comment: { type: 'string', description: 'Description', required: false },
          inputs: {
            type: 'array', description: 'Args', required: true, items: {
              type: 'object',
              description: 'Port',
              properties: {
                id: { type: 'string', description: 'Unique ID', required: true },
                type: { type: 'string', description: 'Data type', required: true, enum: [...PRIMITIVE_TYPES] as string[] },
                comment: { type: 'string', description: 'Description', required: false },
                builtin: { type: 'string', description: 'Builtin annotation', required: false, enum: BuiltinNameSchema.options as string[] },
                location: { type: 'number', description: 'Location index', required: false }
              }
            }
          },
          outputs: {
            type: 'array', description: 'Returns', required: true, items: {
              type: 'object',
              description: 'Port',
              properties: {
                id: { type: 'string', description: 'Unique ID', required: true },
                type: { type: 'string', description: 'Data type', required: true, enum: [...PRIMITIVE_TYPES] as string[] },
                comment: { type: 'string', description: 'Description', required: false },
                builtin: { type: 'string', description: 'Builtin annotation', required: false, enum: BuiltinNameSchema.options as string[] },
                location: { type: 'number', description: 'Location index', required: false }
              }
            }
          },
          localVars: {
            type: 'array', description: 'Locals', required: true, items: {
              type: 'object',
              description: 'Variable',
              properties: {
                id: { type: 'string', description: 'Unique ID', required: true },
                type: { type: 'string', description: 'Data type', required: true, enum: [...PRIMITIVE_TYPES] as string[] },
                initialValue: { type: 'any_value', description: 'Initial value', required: false },
                comment: { type: 'string', description: 'Description', required: false }
              }
            }
          },
          nodes: {
            type: 'array', description: 'Nodes', required: true, items: {
              type: 'object',
              description: 'Node',
              properties: {
                id: { type: 'string', description: 'Unique ID', required: true },
                op: { type: 'string', description: 'Op Code', required: true }, // BuiltinOp enum is handled by opDefToFunctionDeclaration, but for patching we allow string
                comment: { type: 'string', description: 'Description', required: false }
              }
            }
          }
        }
      }
    },
    comment: { type: 'string', description: 'Optional comment', required: false }
  }
});

export const ALL_SCHEMAS = {
  IR: IRSchema
};
