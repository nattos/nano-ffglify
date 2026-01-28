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
 * - `Note` is currently the only concrete entity; removal requires updating `mock-responses.ts` (but NOT `schemas.ts`, which is generic).
 */
import { defineSchema } from './schemas';


export interface BaseEntity {
  id: string;
}

export interface Note extends BaseEntity {
  body: string;
  refs: string[]; // IDs of referenced notes
  created_at: number;
  updated_at: number;
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
  activeTab: 'state' | 'logs' | 'script';
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
  selectedEntity?: { id: string; type: 'Note' };
  selectionHistory: { id: string; type: 'Note' }[]; // Back stack
  selectionFuture: { id: string; type: 'Note' }[]; // Forward stack
}

export interface DatabaseState {
  notes: Record<string, Note>;
  chat_history: ChatMsg[];
}

// Utility Types
export const NoteSchema = defineSchema<Note>({
  name: 'Note',
  description: 'A text note with optional references to other notes.',
  fields: {
    id: { type: 'string', description: 'UUID', required: false },
    body: { type: 'string', description: 'The content of the note', required: true },
    refs: {
      type: 'array',
      description: 'List of Referenced Note IDs',
      required: false,
      items: { type: 'string', description: 'Note ID' }
    }
  }
});

export const ALL_SCHEMAS = {
  Note: NoteSchema
};
