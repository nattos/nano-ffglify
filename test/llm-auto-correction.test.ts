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
      appState.database.ir = { id: 'current-ir', version: '1.0', meta: { name: 'Empty' }, entryPoint: '', inputs: [], resources: [], structs: [], functions: [] };
    });
  });

  it('should auto-correct invalid tool parameters by feeding back validation errors', async () => {
    // 1. Setup Spies
    const generateSpy = vi.spyOn(llmManager, 'generateResponse');

    // 2. Mock Responses

    // Attempt 1: Invalid IR (Missing version)
    generateSpy.mockResolvedValueOnce({
      text: "I'll create that graph.",
      tool_calls: [{
        name: "upsertIR",
        arguments: {
          entity: {
            id: "new_ir",
            meta: { name: "Test Shader" },
            entryPoint: "main",
            functions: []
            // Missing version
          }
        }
      }]
    });

    // Attempt 2: Corrected IR
    generateSpy.mockResolvedValueOnce({
      text: "Sorry, I missed the version. Correcting now.",
      tool_calls: [{
        name: "upsertIR",
        arguments: {
          entity: {
            id: "new_ir",
            version: "3.0.0",
            meta: { name: "Test Shader" },
            entryPoint: "main",
            functions: []
          }
        }
      }]
    });

    // 3. Trigger User Message
    await chatHandler.handleUserMessage("Create a shader graph");

    // 4. Verification

    // Expect 2 calls to LLM
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Verify second call prompt (includes error)
    const lastCallArgs = generateSpy.mock.calls[generateSpy.mock.calls.length - 1];
    expect(lastCallArgs[0]).toContain("Tool execution failed");
    expect(lastCallArgs[0]).toContain("version"); // Field name error

    // Verify final state (IR updated)
    const ir = appState.database.ir;
    expect(ir).toBeDefined();
    expect(ir.meta.name).toBe("Test Shader");
    expect(ir.version).toBe("3.0.0");
  });
});
