/**
 * @file mock-responses.ts
 * @description A registry of deterministic LLM responses for test/demo scripts.
 * Used when `useMockLLM` is active or during automated tests.
 *
 * @external-interactions
 * - Loaded by `llm-manager.ts` into a registry.
 * - Used by `script-runner.ts` to simulate "Happy Path" execution.
 *
 * @pitfalls
 * - This file can get out of sync with the actual `NoteSchema`. If schema changes, these JSON blobs might become invalid.
 * - keys are matched fuzzy-regex in `llm-manager.ts`.
 */
import { LLMResponse } from '../llm/llm-manager';

export const NOTES_MOCKS: Record<string, LLMResponse> = {
  "hello": {
    text: "Hello! I am your Notes Assistant. You can ask me to create notes, update them, or link them together."
  },
  "make a note about groceries": {
    text: "I've created a note for groceries.",
    tool_calls: [{
      name: "upsertNote",
      arguments: {
        entity: {
          body: "Groceries to buy"
        }
      }
    }]
  },
  "add milk to groceries": {
    text: "Added milk to the grocery note.",
    tool_calls: [{
      name: "upsertNote",
      arguments: {
        entity: {
          id: "EXISTING_ID_FOR_DEMO", // In real flow, we'd query first
          body: "Groceries to buy\n- Milk"
        }
      }
    }]
  },
  "link the grocery note to the recipe note": {
    text: "Linked the notes.",
    tool_calls: [{
      name: "patchNote",
      arguments: {
        entity_id: "EXISTING_ID_FOR_DEMO",
        patches: [{ op: "add", path: "/refs/-", value: "recipe_note_id" }]
      }
    }]
  }
};

export const DEMO_SCRIPT = Object.keys(NOTES_MOCKS);
