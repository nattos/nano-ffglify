/**
 * @file controller.ts
 * @description The main entry point for User and System actions.
 * Orchestrates inputs from the UI, delegates to `EntityManager` for mutations, and triggers History recording.
 *
 * @external-interactions
 * - `addChatMessage`: Updates UI state and persists chat interactions.
 * - `mutate`: The central bottleneck for Database mutations, wrapping them in History and Persistence calls.
 * - Usage: `appController.undo()` or `appController.mutate(...)`.
 *
 * @pitfalls
 * - Do NOT modify `appState.database` directly from views or other services. ALWAYS use `appController.mutate` (or `entityManager` which calls `mutate`).
 * - Direct modification bypasses Undo/Redo and Auto-Save.
 */
import { runInAction, toJS } from 'mobx';
import { appState } from '../domain/state';
import { ChatMsg, LLMLogEntry, IRDocument, DatabaseState } from '../domain/types';
import { historyManager } from './history';
import { settingsManager } from './settings';
import { validateIR } from '../ir/validator';
import { getSharedDevice } from '../webgpu/gpu-device';
import { ReplManager } from '../runtime/repl-manager';
import { RuntimeManager } from '../runtime/runtime-manager';

import { CompileResult } from './entity-api';

export interface MutateOptions {
  needsCompile?: boolean;
}

export interface MutateTask {
  compileResult?: Promise<CompileResult>;
}

export class AppController {
  public readonly repl = new ReplManager();
  public readonly runtime = new RuntimeManager();

  private lastCompiledIRJson: string | null = null;
  private activeCompileResolver: ((res: CompileResult) => void) | null = null;
  private activeCompilePromise: Promise<CompileResult> | null = null;

  public setActiveTab(tab: 'live' | 'ir' | 'raw_code' | 'state' | 'script' | 'logs') {
    runInAction(() => {
      appState.local.settings.activeTab = tab;
    });
    this.saveSettings();
  }

  private saveSettings() {
    settingsManager.saveSettings(toJS(appState.local.settings));
  }

  public setChatOpen(open: boolean) {
    runInAction(() => {
      appState.local.settings.chatOpen = open;
    });
    settingsManager.saveSettings(toJS(appState.local.settings));
  }

  public toggleMockLLM(useMock: boolean) {
    runInAction(() => {
      appState.local.settings.useMockLLM = useMock;
    });
    settingsManager.saveSettings(toJS(appState.local.settings));
  }

  public logLLMInteraction(entry: LLMLogEntry) {
    console.log("[AppController] Logging LLM Interaction:", entry);
    runInAction(() => {
      appState.local.llmLogs.unshift(entry);
      // Cap logs to 50
      if (appState.local.llmLogs.length > 50) {
        appState.local.llmLogs.length = 50;
      }
    });
  }

  private saveDatabase() {
    settingsManager.saveDatabase(toJS(appState.database));
  }

  public undo() {
    historyManager.undo();
    this.saveDatabase();
  }

  public redo() {
    historyManager.redo();
    this.saveDatabase();
  }

  public clearLogs() {
    runInAction(() => {
      appState.local.llmLogs.length = 0;
    });
  }

  public setDraftChat(text: string) {
    runInAction(() => {
      appState.local.draftChat = text;
    });
  }

  public setActiveRewindId(id: string | null) {
    runInAction(() => {
      appState.local.activeRewindId = id;
    });
  }

  public setSelectedEntity(id: string | null, type?: 'IR') {
    // Standard select resets history (Breadcrumbs)
    runInAction(() => {
      appState.local.selectionHistory = [];
      appState.local.selectionFuture = [];
      if (!id) {
        appState.local.selectedEntity = undefined;
      } else if (type) {
        appState.local.selectedEntity = { id, type };
      }
    });
  }

  public drillDown(id: string, type: 'IR') {
    runInAction(() => {
      if (appState.local.selectedEntity) {
        // Push current to history
        appState.local.selectionHistory.push(appState.local.selectedEntity);
        // New branch clears future
        appState.local.selectionFuture = [];
      }
      appState.local.selectedEntity = { id, type };
    });
  }

  public validateCurrentIR() {
    console.info("[AppController] Validating IR...");
    const ir = appState.database.ir;
    const errors = validateIR(ir);
    runInAction(() => {
      appState.local.validationErrors = errors;
      if (errors.length) {
        this.setActiveTab('raw_code');
      }
    });
    return !errors.length;
  }

  public async play() {
    // Ensure we have compiled code.
    if (!this.ensureCompiled()) {
      return;
    }

    if (appState.local.settings.activeTab !== 'live') {
      this.setActiveTab('live');
    }

    runInAction(() => {
      appState.local.settings.transportState = 'playing';
    });
    this.saveSettings();
    this.runtime.play();
  }

  public pause() {
    runInAction(() => {
      appState.local.settings.transportState = 'paused';
    });
    this.saveSettings();
    this.runtime.pause();
  }

  public stop() {
    runInAction(() => {
      appState.local.settings.transportState = 'stopped';
    });
    this.saveSettings();
    this.runtime.stop();
  }

  /**
   * Restores transport state from settings.
   * Called once app is initialized and IR is supposedly loaded.
   */
  public async restoreTransportState() {
    const s = appState.local.settings.transportState;
    console.info("[AppController] Restoring transport state:", s);
    if (s === 'playing') {
      await this.play();
    } else if (s === 'paused') {
      // For paused, we still want to compile if possible to show a frame?
      // But maybe just let it be.
      this.runtime.pause();
    } else {
      this.runtime.stop();
    }
  }

  public async compileCurrentIR(): Promise<boolean> {
    const res = await this.performCompile();
    if (res.compileStatus === 'fail') {
      alert("Compilation failed: " + (res.errors?.[0]?.message || "unknown error"));
    }
    return res.compileStatus === 'success';
  }

  // runOne is now managed by RuntimeManager

  public goBack() {
    runInAction(() => {
      const prev = appState.local.selectionHistory.pop();
      if (prev) {
        if (appState.local.selectedEntity) {
          appState.local.selectionFuture.push(appState.local.selectedEntity);
        }
        appState.local.selectedEntity = prev;
      } else {
        // If history empty, we might act as "close", but for now just clear
        appState.local.selectedEntity = undefined;
        appState.local.selectionFuture = []; // Clear future if we exited?
      }
    });
  }

  public goForward() {
    runInAction(() => {
      const next = appState.local.selectionFuture.pop();
      if (next) {
        if (appState.local.selectedEntity) {
          appState.local.selectionHistory.push(appState.local.selectedEntity);
        }
        appState.local.selectedEntity = next;
      }
    });
  }

  public rewindToChat(targetId: string) {
    // 1. Find message text
    const history = appState.database.chat_history;
    const msg = history.find(m => m.id === targetId);
    if (!msg) return;

    // 2. Set draft
    if (msg.role === 'user' && msg.text) {
      this.setDraftChat(msg.text);
    }

    // 3. Undo loop
    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
      const currentHistory = appState.database.chat_history;
      const exists = currentHistory.some(m => m.id === targetId);

      if (!exists) {
        break; // Target removed!
      }

      // Perform undo
      this.undo();
      attempts++;
    }

    // Clear active rewind
    this.setActiveRewindId(null);
  }

  public mutate(description: string, source: 'user' | 'llm', recipe: (draft: DatabaseState) => void, options?: MutateOptions): MutateTask {
    const task: MutateTask = {};
    runInAction(() => {
      historyManager.record(description, source, recipe);
      this.saveDatabase();
    });

    if (options?.needsCompile) {
      task.compileResult = this.performCompile();
    }

    return task;
  }

  private async ensureCompiled() {
    if (this.repl.currentArtifacts) {
      return true;
    }
    let success = false;
    if (this.activeCompilePromise) {
      const res = await this.activeCompilePromise;
      return res.compileStatus === 'success';
    } else {
      return await this.compileCurrentIR();
    }
  }

  private async performCompile(): Promise<CompileResult> {
    // 1. Cancel previous in-flight compilation
    if (this.activeCompileResolver) {
      this.activeCompileResolver({ compileStatus: 'timeout' });
      this.activeCompileResolver = null;
    }

    // 2. Check for redundant work
    const ir = appState.database.ir;
    const irJson = JSON.stringify(ir);
    if (irJson === this.lastCompiledIRJson) {
      return { compileStatus: 'success' };
    }

    // 3. Start new compilation task
    this.activeCompilePromise = new Promise<CompileResult>(async (resolve) => {
      this.activeCompileResolver = resolve;

      // Local timeout for THIS specific turn
      const timeoutTimer = setTimeout(() => {
        if (this.activeCompileResolver === resolve) {
          resolve({ compileStatus: 'timeout' });
          this.activeCompileResolver = null;
        }
      }, 10000);

      const compileTask = (async (): Promise<CompileResult> => {
        const isValid = this.validateCurrentIR();
        if (!isValid) {
          return {
            compileStatus: 'fail',
            errors: this.repl.validationErrors
          };
        }

        const artifacts = await this.repl.compile(ir);
        if (artifacts) {
          this.repl.swap(artifacts);

          try {
            const device = await getSharedDevice();
            await this.runtime.setCompiled(artifacts, device);
          } catch (gpuError) {
            console.warn("[AppController] GPU environment not available for live update:", gpuError);
          }

          runInAction(() => {
            appState.local.compilationResult = {
              js: artifacts.compiled.taskCode,
              jsInit: artifacts.compiled.initCode,
              wgsl: artifacts.wgsl
            };
          });

          return { compileStatus: 'success' };
        } else {
          return {
            compileStatus: 'fail',
            errors: this.repl.validationErrors
          };
        }
      })();

      const res = await compileTask;

      // Only resolve if we haven't been superseded or timed out
      if (this.activeCompileResolver === resolve) {
        clearTimeout(timeoutTimer);
        if (res.compileStatus === 'success') {
          this.lastCompiledIRJson = irJson;
        }
        resolve(res);
        this.activeCompileResolver = null;
        this.activeCompilePromise = null;
      }
    });

    return this.activeCompilePromise;
  }

  public addChatMessage(msg: Partial<ChatMsg>) {
    // ... (rest of method)
    // Ensure ID exists
    const fullMsg: ChatMsg = {
      id: msg.id || crypto.randomUUID(),
      role: msg.role || 'assistant',
      text: msg.text,
      type: msg.type,
      data: msg.data
    };

    runInAction(() => {
      historyManager.record('New Chat Message', fullMsg.role === 'user' ? 'user' : 'llm', (draft) => {
        if (!draft.chat_history) draft.chat_history = [];

        // Deduplication Logic for Entity Updates
        if (fullMsg.type === 'entity_update' && fullMsg.data?.entity?.id) {
          draft.chat_history = draft.chat_history.filter(m => {
            if (m.type === 'entity_update' && m.data?.entity?.id === fullMsg.data.entity.id) {
              return false; // Remove old card
            }
            return true;
          });
        }

        draft.chat_history.push(fullMsg);
      });
      // Save after mutation
      this.saveDatabase();
    });
  }
}

export const appController = new AppController();
