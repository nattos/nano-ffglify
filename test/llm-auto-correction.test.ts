import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatHandler } from '../src/llm/chat-handler';
import { llmManager } from '../src/llm/llm-manager';
import { appState } from '../src/domain/state';
import { runInAction } from 'mobx';

// Mock settings
vi.mock('../src/state/settings', () => ({
  settingsManager: {
    loadSettings: vi.fn().mockResolvedValue(null),
    saveSettings: vi.fn(),
    loadDatabase: vi.fn(),
    saveDatabase: vi.fn()
  }
}));

describe('LLM Auto-Correction Flow', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    runInAction(() => {
      appState.database.notes = {}; // Reset items
    });
  });

  it('should auto-correct invalid tool parameters by feeding back validation errors', async () => {
    // 1. Setup Spies
    const generateSpy = vi.spyOn(llmManager, 'generateResponse');

    // 2. Mock Responses

    // Attempt 1: Invalid Entity (Missing body)
    generateSpy.mockResolvedValueOnce({
      text: "I'll create that note.",
      tool_calls: [{
        name: "upsertNote",
        arguments: {
          entity: {
            id: "new_note"
            // Missing body
          }
        }
      }]
    });

    // Attempt 2: Corrected Entity
    generateSpy.mockResolvedValueOnce({
      text: "Sorry, I missed the body. Correcting now.",
      tool_calls: [{
        name: "upsertNote",
        arguments: {
          entity: {
            id: "new_note",
            body: "This is the content.",
            refs: []
          }
        }
      }]
    });

    // 3. Trigger User Message
    await chatHandler.handleUserMessage("Create a note");

    // 4. Verification

    // Expect 2 calls to LLM (since we removed router, it goes straight to worker)
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Verify second call prompt (includes error)
    const lastCallArgs = generateSpy.mock.calls[generateSpy.mock.calls.length - 1];
    expect(lastCallArgs[0]).toContain("Tool execution failed");
    expect(lastCallArgs[0]).toContain("body"); // Field name error

    // Verify final state (note exists)
    const notes = Object.values(appState.database.notes);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("This is the content.");
  });

});
