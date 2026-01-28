import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appState } from '../src/domain/state';
import { chatHandler } from '../src/llm/chat-handler';
import { llmManager } from '../src/llm/llm-manager';
import { historyManager } from '../src/state/history';
import { runInAction } from 'mobx';

// Mock SettingsManager to avoid IDB issues in tests
vi.mock('../src/state/settings', () => ({
  settingsManager: {
    loadSettings: vi.fn().mockResolvedValue(null),
    saveSettings: vi.fn(),
    loadDatabase: vi.fn(),
    saveDatabase: vi.fn()
  }
}));

describe('LLM Integration Flow', () => {

  beforeEach(() => {
    // Reset state
    runInAction(() => {
      historyManager.history.length = 0;
      historyManager.redoStack.length = 0;
      appState.database.notes = {};
      appState.database.chat_history = [];
    });
  });

  it('should handle "upsertNote" tool call and update state', async () => {
    // 1. Mock LLM Response
    const response = {
      text: "Sure, created a note.",
      tool_calls: [{
        name: "upsertNote",
        arguments: {
          entity: {
            id: "note_1",
            body: "Meeting Notes\n- Action items",
            refs: []
          }
        }
      }]
    };

    // Use Mock Implementation
    vi.spyOn(llmManager, 'generateResponse').mockResolvedValue(response);

    // 2. Simulate User Message
    await chatHandler.handleUserMessage("Draft meeting notes");

    // 3. Assert State Change
    const note = appState.database.notes["note_1"];
    expect(note).toBeDefined();
    expect(note.body).toBe("Meeting Notes\n- Action items");

    // 4. Assert History (Mutation Log)
    // History contains chat logs too, so find the mutation
    // Note: The description depends on how historyManager records it. Currently it might be generic.
    const mutation = historyManager.history.find(h => h.description.toLowerCase().includes("note"));
    expect(mutation).toBeDefined();
  });

  it('should undo mutation correctly', async () => {
    // Setup: Perform an action first
    const response = {
      text: "Created note",
      tool_calls: [{
        name: "upsertNote",
        arguments: {
          entity: { id: "note_undo", body: "Undo this note", refs: [] }
        }
      }]
    };

    vi.spyOn(llmManager, 'generateResponse').mockResolvedValue(response);

    await chatHandler.handleUserMessage("Make a note");

    // Verify it was added
    expect(appState.database.notes["note_undo"]).toBeDefined();

    // Undo loop until we undo the mutation
    let undone = false;
    for (let i = 0; i < 5; i++) {
      historyManager.undo();
      if (!appState.database.notes["note_undo"]) {
        undone = true;
        break;
      }
    }

    // Verify it's gone
    expect(appState.database.notes["note_undo"]).toBeUndefined();
  });

  it('should handle missing entity body gracefully (Regression)', async () => {
    // 1. Inject malformed note directly into state (simulating some corruption or bad past state)
    runInAction(() => {
      // @ts-ignore
      appState.database.notes['bad_note'] = {
        id: 'bad_note',
        // body is MISSING
        created_at: 0
      };
    });

    // 2. Mock GenAI to avoid actual call/crash if it gets that far
    vi.spyOn(llmManager, 'generateResponse').mockResolvedValue({ text: "Error avoided" });

    // 2. Trigger Chat
    // We expect this to succeed (handled gracefully), verifying prompts build correctly even with bad data
    await chatHandler.handleUserMessage("hi");
  });
});
