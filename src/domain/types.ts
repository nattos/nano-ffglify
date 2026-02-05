/**
 * @file types.ts
 * @description Defines the core data model (Entities) and their relationships.
 * This is a "Blueprint" file that should be customized for each specific app.
 *
 * @external-interactions
 * - Uses `schemas.ts` (via `defineSchema`) to create verifiable LLM tool definitions.
 * - Used by `state.ts` to define the shape of the database.
 *
 * @pitfalls
 * - Ensure `BaseEntity` is extended by all persistable types.
 * - `IRDocument` is the central entity.
 */
import { defineSchema } from './schemas';
import { IRDocument as BaseIRDocument } from '../ir/types';
import { LogicValidationError } from '../ir/validator';

export type IRDocument = BaseIRDocument;

export interface BaseEntity {
  id: string;
}

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ChatMsg {
  id: string; // UUID
  role: 'user' | 'assistant';
  text?: string;
  type?: 'text' | 'poll' | 'proposal' | 'entity_update';
  data?: any;
}

export interface AppSettings {
  activeTab: 'state' | 'logs' | 'script' | 'results' | 'ir';
  chatOpen: boolean;
  useMockLLM: boolean;
}

export interface LLMLogEntry {
  id: string;
  timestamp: number;
  duration_ms: number;
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
  ir: IRDocument & { id: string };
  chat_history: ChatMsg[];
}

// Utility Types
export const IRSchema = defineSchema<IRDocument & { id: string }>({
  name: 'IR',
  description: 'The Intermediate Representation document of the shader graph.',
  fields: {
    id: { type: 'string', description: 'Unique identifier for the document', required: false },
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
          ui: { type: 'object', description: 'UI Hint', required: false, properties: {} }
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
          structType: { type: 'array', description: 'Custom layout members', required: false, items: { type: 'object', description: 'Member', properties: {} } as any }
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
          id: { type: 'string', description: 'Type Name', required: true },
          members: { type: 'array', description: 'Members', required: true, items: { type: 'object', description: 'Member', properties: {} } as any },
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
          inputs: { type: 'array', description: 'Args', required: true, items: { type: 'object', description: 'Port', properties: {} } as any },
          outputs: { type: 'array', description: 'Returns', required: true, items: { type: 'object', description: 'Port', properties: {} } as any },
          localVars: { type: 'array', description: 'Locals', required: true, items: { type: 'object', description: 'Variable', properties: {} } as any },
          nodes: { type: 'array', description: 'Nodes', required: true, items: { type: 'object', description: 'Node', properties: {} } as any }
        }
      }
    },
    comment: { type: 'string', description: 'Optional comment', required: false }
  }
});

export const ALL_SCHEMAS = {
  IR: IRSchema
};
