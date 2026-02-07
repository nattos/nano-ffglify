import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from '../src/domain/state';
import { chatHandler } from '../src/llm/chat-handler';

// Mock settings to force useMockLLM = true
vi.mock('../src/state/settings', () => ({
  settingsManager: {
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    loadDatabase: vi.fn(),
    saveDatabase: vi.fn()
  }
}));

describe('Integration: IR App Scenarios', () => {

  beforeEach(() => {
    runInAction(() => {
      // Reset State
      appState.database = {
        ir: { version: '1.0', meta: { name: 'Empty' }, entryPoint: '', inputs: [], resources: [], structs: [], functions: [] },
        chat_history: []
      };

      appState.local.settings.useMockLLM = true;
    });
  });

  it('Scenario: Create and Update Blur Pipeline', async () => {
    // 1. Create Blur Pipeline
    await chatHandler.handleUserMessage("create a blur pipeline");

    runInAction(() => {
      const ir = appState.database.ir;
      expect(ir).toBeDefined();
      expect(ir.meta.name).toBe('Precomputed Blur');
    });

    // 2. Update Kernel Size
    await chatHandler.handleUserMessage("change the kernel size to 32");

    runInAction(() => {
      const ir = appState.database.ir;
      expect(ir.meta.name).toBe('Precomputed Blur');
      expect(ir.inputs[2].default).toBe(32);
    });
  });

  it('Scenario: Querying Documentation', async () => {
    // 1. Ask for documentation
    await chatHandler.handleUserMessage("how do i use math_add");

    runInAction(() => {
      // The chat history should contain the tool execution output
      const history = appState.database.chat_history;

      // Look for the documentation message
      const docMessage = history.find(m => m.role === 'tool-response' && m.data?.docsResult?.name === 'math_add');
      expect(docMessage).toBeDefined();
      expect(docMessage?.data.docsResult.name).toBe('math_add');
      expect(docMessage?.data.docsResult.description).toContain('Standard numeric binary math operation.');
    });
  });
});
