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
    loadDatabase: vi.fn().mockResolvedValue(null),
    saveDatabase: vi.fn(),
    runMigrationIfNeeded: vi.fn().mockResolvedValue(undefined),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    saveWorkspace: vi.fn().mockResolvedValue(undefined),
    loadAllInputFiles: vi.fn().mockResolvedValue(new Map()),
    saveInputFile: vi.fn().mockResolvedValue(undefined),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    deleteWorkspaceData: vi.fn().mockResolvedValue(undefined),
    settingsLoaded: true,
    databaseLoaded: { resolve: vi.fn() },
  }
}));

describe('LLM Auto-Correction Flow', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    runInAction(() => {
      appState.database.ir = { id: 'current-ir', version: '1.0', meta: { name: 'Empty' }, entryPoint: '', inputs: [], resources: [], structs: [], functions: [] };
      appState.local.settings.useMockLLM = true;
    });
  });

  it('should auto-correct invalid tool parameters by feeding back validation errors', async () => {
    // 1. Setup Mock Responses
    const resp1 = {
      text: "I'll create that graph.",
      tool_calls: [{
        name: "replaceIR",
        arguments: {
          id: "new_ir",
          meta: { name: "Test Shader" },
          entryPoint: "main",
          functions: []
          // Missing version
        }
      }]
    };

    const resp2 = {
      text: "Sorry, I missed the version. Correcting now.",
      tool_calls: [{
        name: "replaceIR",
        arguments: {
          id: "new_ir",
          version: "3.0.0",
          meta: { name: "Test Shader" },
          entryPoint: "main",
          functions: []
        }
      }]
    };

    llmManager.setMockRegistry({
      "create a shader graph": [resp1, resp2]
    });

    // 2. Trigger User Message
    await chatHandler.handleUserMessage("Create a shader graph");

    // 3. Verification
    // Verify final state (IR updated)
    const ir = appState.database.ir;
    expect(ir).toBeDefined();
    expect(ir.meta.name).toBe("Test Shader");
    expect(ir.version).toBe("3.0.0");
  });
});
