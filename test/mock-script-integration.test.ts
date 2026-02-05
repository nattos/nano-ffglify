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
        ir: { id: 'current-ir', version: '1.0', meta: { name: 'Empty' }, entryPoint: '', inputs: [], resources: [], structs: [], functions: [] },
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
      expect(ir.id).toBe('blur-ir');
    });

    // 2. Update Kernel Size
    await chatHandler.handleUserMessage("change the kernel size to 32");

    runInAction(() => {
      const ir = appState.database.ir;
      expect(ir.id).toBe('blur-ir');
      expect(ir.inputs[2].default).toBe(32);
    });
  });
});
