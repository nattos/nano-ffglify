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

describe('LLM Integration Flow', () => {

  beforeEach(() => {
    // Reset state
    runInAction(() => {
      historyManager.history.length = 0;
      historyManager.redoStack.length = 0;
      appState.database.ir = {
        id: 'current-ir',
        version: '1.0.0',
        meta: { name: 'Initial IR' },
        entryPoint: '',
        inputs: [],
        resources: [],
        structs: [],
        functions: []
      };
      appState.database.chat_history = [];
    });
  });

  it('should handle "upsertIR" tool call and update state', async () => {
    // 1. Mock LLM Response
    const response = {
      text: "Sure, created a shader graph.",
      tool_calls: [{
        name: "replaceIR",
        arguments: {
          id: "ir_1",
          version: "3.0.0",
          meta: { name: "Blur Shader" },
          entryPoint: "main",
          functions: []
        }
      }]
    };

    // Use Mock Implementation
    vi.spyOn(llmManager, 'generateResponse').mockImplementation(async (prompt, options) => {
      if (options?.executeTool) {
        for (const call of response.tool_calls) {
          await options.executeTool(call.name, call.arguments);
        }
      }
      return response;
    });

    // 2. Simulate User Message
    await chatHandler.handleUserMessage("Create a blur shader");

    // 3. Assert State Change
    const ir = appState.database.ir;
    expect(ir).toBeDefined();
    expect(ir.meta.name).toBe("Blur Shader");
    expect(ir.id).toBe("ir_1");

    // 4. Assert History (Mutation Log)
    const mutation = historyManager.history.find(h => h.description.toLowerCase().includes("ir"));
    expect(mutation).toBeDefined();
  });

  it('should undo mutation correctly', async () => {
    // Setup: Perform an action first
    const response = {
      text: "Created graph",
      tool_calls: [{
        name: "replaceIR",
        arguments: { id: "ir_undo", version: "3.0.0", meta: { name: "Undo Me" }, entryPoint: "main", functions: [] }
      }]
    };

    vi.spyOn(llmManager, 'generateResponse').mockImplementation(async (prompt, options) => {
      if (options?.executeTool) {
        for (const call of response.tool_calls) {
          await options.executeTool(call.name, call.arguments);
        }
      }
      return response;
    });

    await chatHandler.handleUserMessage("Make a shader");

    // Verify it was added
    expect(appState.database.ir.id).toBe("ir_undo");

    // Undo loop until we undo the mutation
    let undone = false;
    for (let i = 0; i < 5; i++) {
      historyManager.undo();
      if (appState.database.ir.id !== "ir_undo") {
        undone = true;
        break;
      }
    }

    // Verify it's back to initial (or at least not ir_undo)
    expect(appState.database.ir.id).not.toBe("ir_undo");
    expect(undone).toBe(true);
  });

  it('should handle missing entry point gracefully (Regression)', async () => {
    // 1. Inject malformed IR directly into state
    runInAction(() => {
      // @ts-ignore
      appState.database.ir = {
        id: 'bad_ir',
        version: '1.0',
        meta: { name: 'Bad' },
        // entryPoint is MISSING
      };
    });

    // 2. Mock GenAI
    vi.spyOn(llmManager, 'generateResponse').mockImplementation(async () => ({ text: "Error avoided" }));

    // 2. Trigger Chat
    await chatHandler.handleUserMessage("hi");
  });
});
