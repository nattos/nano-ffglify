import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appState } from '../src/domain/state';
import { appController } from '../src/state/controller';
import { chatHandler } from '../src/llm/chat-handler';
import { llmManager } from '../src/llm/llm-manager';
import { historyManager } from '../src/state/history';
import { runInAction } from 'mobx';
import { ChatImageAttachment } from '../src/domain/types';

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

// Tiny 1x1 PNG base64
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeImage(mime = 'image/png', data = TINY_PNG): ChatImageAttachment {
  return { mimeType: mime, data };
}

describe('Image Attachments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
      appState.local.draftImages = [];
      appState.local.draftChat = '';
    });
  });

  describe('Draft image management', () => {
    it('should add a draft image', () => {
      const img = makeImage();
      appController.addDraftImage(img);
      expect(appState.local.draftImages).toHaveLength(1);
      expect(appState.local.draftImages[0].mimeType).toBe('image/png');
    });

    it('should remove a draft image by index', () => {
      appController.addDraftImage(makeImage('image/png'));
      appController.addDraftImage(makeImage('image/jpeg'));
      appController.removeDraftImage(0);
      expect(appState.local.draftImages).toHaveLength(1);
      expect(appState.local.draftImages[0].mimeType).toBe('image/jpeg');
    });

    it('should clear all draft images', () => {
      appController.addDraftImage(makeImage());
      appController.addDraftImage(makeImage());
      appController.clearDraftImages();
      expect(appState.local.draftImages).toHaveLength(0);
    });
  });

  describe('Chat message with images', () => {
    it('should persist images in ChatMsg', async () => {
      const images = [makeImage()];
      vi.spyOn(llmManager, 'generateResponse').mockResolvedValue({ text: 'OK' });
      await chatHandler.handleUserMessage('Check this image', images);

      const userMsg = appState.database.chat_history.find(m => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(userMsg!.images).toHaveLength(1);
      expect(userMsg!.images![0].mimeType).toBe('image/png');
      expect(userMsg!.images![0].data).toBe(TINY_PNG);
    });

    it('should produce multimodal prompt when images present', async () => {
      const spy = vi.spyOn(llmManager, 'generateResponse').mockResolvedValue({ text: 'OK' });
      await chatHandler.handleUserMessage('Describe this', [makeImage()]);

      const promptArg = spy.mock.calls[0][0];
      expect(Array.isArray(promptArg)).toBe(true);
      const arr = promptArg as any[];
      expect(typeof arr[0]).toBe('string');
      expect(arr[1]).toHaveProperty('inlineData');
      expect(arr[1].inlineData.mimeType).toBe('image/png');
    });

    it('should produce string prompt without images', async () => {
      const spy = vi.spyOn(llmManager, 'generateResponse').mockResolvedValue({ text: 'OK' });
      await chatHandler.handleUserMessage('Hello');

      const promptArg = spy.mock.calls[0][0];
      expect(typeof promptArg).toBe('string');
    });

    it('should handle multiple images', async () => {
      const spy = vi.spyOn(llmManager, 'generateResponse').mockResolvedValue({ text: 'OK' });
      const images = [makeImage('image/png'), makeImage('image/jpeg')];
      await chatHandler.handleUserMessage('Two images', images);

      // Verify in chat history
      const userMsg = appState.database.chat_history.find(m => m.role === 'user');
      expect(userMsg!.images).toHaveLength(2);

      // Verify prompt array
      const promptArg = spy.mock.calls[0][0] as any[];
      expect(Array.isArray(promptArg)).toBe(true);
      expect(promptArg).toHaveLength(3); // text + 2 images
    });

    it('should handle image-only message (empty text)', async () => {
      const spy = vi.spyOn(llmManager, 'generateResponse').mockResolvedValue({ text: 'Got it' });
      await chatHandler.handleUserMessage('', [makeImage()]);

      const userMsg = appState.database.chat_history.find(m => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(userMsg!.images).toHaveLength(1);

      const promptArg = spy.mock.calls[0][0];
      expect(Array.isArray(promptArg)).toBe(true);
    });

    it('should not set images field when no images provided', async () => {
      vi.spyOn(llmManager, 'generateResponse').mockResolvedValue({ text: 'OK' });
      await chatHandler.handleUserMessage('Plain text');

      const userMsg = appState.database.chat_history.find(m => m.role === 'user');
      expect(userMsg!.images).toBeUndefined();
    });
  });
});
