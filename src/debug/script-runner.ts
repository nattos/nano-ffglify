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
import { AppController, MutateOptions, MutateTask } from '../state/controller';
import { runInAction, toJS } from 'mobx';
import { ReplManager } from '../runtime/repl-manager';
import { CompileResult } from '../state/entity-api';
import { validateIR } from '../ir/validator';
import { PromptBuilder } from '../domain/prompt-builder';

export async function runScriptDebug(
  targetIndex: number,
  script: string[],
  targetUseMock: boolean
): Promise<{ logs: LLMLogEntry[], finalState: any }> {

  const logs: LLMLogEntry[] = [];

  // Placeholder for real appState, to be assigned after env creation
  let refAppState: any = null;
  let refHistoryManager: any = null;

  const scriptRepl = new ReplManager();
  let lastCompiledIRJson: string | null = null;
  let activeCompilePromise: Promise<CompileResult> | null = null;

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
    mutate: (desc: string, src: string, recipe: any, options?: MutateOptions): MutateTask => {
      if (refHistoryManager) {
        refHistoryManager.record(desc, src as any, recipe);
      }

      const task: MutateTask = {};
      if (options?.needsCompile) {
        task.compileResult = mockController.performCompile();
      }
      return task;
    },
    ensureCompiled: async () => {
      if (scriptRepl.currentArtifacts) return true;
      if (activeCompilePromise) {
        const res = await activeCompilePromise;
        return res.compileStatus === 'success';
      }
      const res = await mockController.performCompile();
      return res.compileStatus === 'success';
    },
    performCompile: async (): Promise<CompileResult> => {
      const ir = refAppState.database.ir;
      const irJson = JSON.stringify(ir);
      if (irJson === lastCompiledIRJson) {
        return { compileStatus: 'success' };
      }

      activeCompilePromise = (async () => {
        const errors = validateIR(ir);
        if (errors.length) {
          runInAction(() => { refAppState.local.validationErrors = errors; });
          return { compileStatus: 'fail', errors };
        }

        const artifacts = await scriptRepl.compile(ir);
        if (artifacts) {
          scriptRepl.swap(artifacts);
          runInAction(() => {
            refAppState.local.compilationResult = {
              js: artifacts.compiled.taskCode,
              jsInit: artifacts.compiled.initCode,
              wgsl: artifacts.wgsl
            };
            refAppState.local.validationErrors = [];
          });
          lastCompiledIRJson = irJson;
          return { compileStatus: 'success' };
        } else {
          const vErrors = toJS(scriptRepl.validationErrors);
          runInAction(() => { refAppState.local.validationErrors = vErrors; });
          return { compileStatus: 'fail', errors: vErrors };
        }
      })();

      const res = await activeCompilePromise;
      activeCompilePromise = null;
      return res;
    },
    debugValidateCurrentIR: () => {
      const ir = refAppState.database.ir;
      const errors = validateIR(ir);
      runInAction(() => {
        refAppState.local.validationErrors = errors;
      });
      return !errors.length;
    },
    logLLMInteraction: (entry: LLMLogEntry) => {
      // Deep clone to safely store snapshot
      logs.push(JSON.parse(JSON.stringify(entry)));
    },
    // Required stubs for DI
    setActiveTab: (tab: any) => {
      runInAction(() => { refAppState.local.settings.activeTab = tab; });
    },
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
    rewindToChat: () => { },
    compileCurrentIR: async () => {
      const res = await mockController.performCompile();
      return res.compileStatus === 'success';
    }
  }, {
    get: (target, prop) => {
      if (prop in target) return (target as any)[prop];
      return () => { }; // Default no-op
    }
  }) as unknown as AppController;

  // Real LLM Manager (but using our capturing controller)
  // This enables real API calls if targetUseMock is false.
  const llmManager = new GoogleGenAIManager(mockController, PromptBuilder.buildWorkerSystemInstruction());

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
