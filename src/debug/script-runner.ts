/**
 * @file script-runner.ts
 * @description Executes the "Demo Script" in a debugging sandbox.
 * Replays history up to a specific line to inspect state at that point.
 *
 * @external-interactions
 * - Uses `createIsolatedEnv` to spawn the sandbox.
 * - Logs results to a format readable by the "LLM Logs" UI.
 *
 * @pitfalls
 * - This is expensive. it replays the ENTIRE script from scratch for every line click.
 * - Does not use real IndexDB.
 */
import { INITIAL_DATABASE_STATE } from '../domain/init';
import { createIsolatedEnv } from './isolation';
import { LLMLogEntry } from '../domain/types';
import { GoogleGenAIManager } from '../llm/llm-manager';
import { AppController } from '../state/controller';
import { runInAction, toJS } from 'mobx';

const apiKey = import.meta.env.GOOGLE_API_KEY || "TEST_KEY";

export async function runScriptDebug(
  targetIndex: number,
  script: string[],
  targetUseMock: boolean
): Promise<{ logs: LLMLogEntry[], finalState: any }> {

  const logs: LLMLogEntry[] = [];

  // Placeholder for real appState, to be assigned after env creation
  let refAppState: any = null;
  let refHistoryManager: any = null;

  // Custom Controller to capture logs and Manage State
  // We use a Proxy to catch everything else as no-op
  const mockController = new Proxy({
    addChatMessage: (msg: any) => {
      // Replicate minimal logic from AppController to ensure history accumulates
      if (refAppState) {
        const fullMsg = {
          id: msg.id || crypto.randomUUID(),
          role: msg.role || 'assistant',
          text: msg.text,
          type: msg.type,
          data: msg.data
        };

        runInAction(() => {
          // Simple push for debug runner
          // We don't need full deduplication logic unless strictly necessary for the script
          refAppState.database.chat_history.push(fullMsg);
        });
      }
    },
    mutate: (desc: string, src: string, recipe: any) => {
      // Warning: This is a hacky way to access the history manager inside the isolated env
      // because we don't have direct access to it from here easily without refactoring the factory to return it map.
      // BUT wait! We DO have 'env.historyManager' returned from createIsolatedEnv!
      // So we can implement this properly if we defer the execution or wrap it?

      // Actually, we can just grab it from env globally (in this scope) once created.
      // But 'env' is created AFTER this proxy.
      // So we need a ref similar to refAppState.

      if (refHistoryManager) {
        refHistoryManager.record(desc, src as any, recipe);
      }
    },
    logLLMInteraction: (entry: LLMLogEntry) => {
      // Deep clone to safely store snapshot
      logs.push(JSON.parse(JSON.stringify(entry)));
    },
    // Required stubs for DI
    setActiveTab: () => { },
    setChatOpen: () => { },
    toggleMockLLM: () => { },
    undo: () => { },
    redo: () => { },
    clearLogs: () => { },
    setDraftChat: () => { },
    setActiveRewindId: () => { },
    setSelectedEntity: () => { },
    drillDown: () => { },
    goBack: () => { },
    goForward: () => { },
    rewindToChat: () => { }
  }, {
    get: (target, prop) => {
      if (prop in target) return (target as any)[prop];
      return () => { }; // Default no-op
    }
  }) as unknown as AppController;

  // Real LLM Manager (but using our capturing controller)
  // This enables real API calls if targetUseMock is false.
  const llmManager = new GoogleGenAIManager(apiKey, mockController);

  const env = createIsolatedEnv(INITIAL_DATABASE_STATE, {
    controller: mockController,
    llm: llmManager
  });
  refAppState = env.appState;
  refHistoryManager = env.historyManager;

  // 1. Run Pre-Requisites (Forced Mock)
  for (let i = 0; i < targetIndex; i++) {
    runInAction(() => { env.appState.local.settings.useMockLLM = true; });
    await env.chatHandler.handleUserMessage(script[i]);
  }

  // 2. Run Target (Effective Settings)
  runInAction(() => {
    // Clear logs to only capture the final step interactions?
    // The user likely wants to see the debug info for the LINE they clicked.
    logs.length = 0;

    env.appState.local.settings.useMockLLM = targetUseMock;
  });

  await env.chatHandler.handleUserMessage(script[targetIndex]);

  return { logs, finalState: toJS(env.appState.database) };
}
