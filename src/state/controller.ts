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
import { AppSettings, ChatMsg, LLMLogEntry, IRDocument, DatabaseState, SavedInputFile, WorkspaceIndexEntry } from '../domain/types';
import { INITIAL_DATABASE_STATE } from '../domain/init';
import { historyManager } from './history';
import { settingsManager } from './settings';
import { validateIR } from '../ir/validator';
import { getSharedDevice } from '../webgpu/gpu-device';
import { ReplManager } from '../runtime/repl-manager';
import { RuntimeManager, RuntimeInputType } from '../runtime/runtime-manager';
import { CompileResult } from './entity-api';

// Late-bound reference to avoid circular dependency (chat-handler imports controller)
let _chatHandler: { stop(): void } | null = null;
export function registerChatHandler(handler: { stop(): void }) {
  _chatHandler = handler;
}

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

  public get activeWorkspaceId(): string {
    return appState.local.settings.activeWorkspaceId || '';
  }

  public setActiveTab(tab: AppSettings['activeTab']) {
    runInAction(() => {
      appState.local.settings.activeTab = tab;
    });
    this.saveSettings();
  }

  public setDevMode(enabled: boolean) {
    runInAction(() => {
      appState.local.settings.devMode = enabled;
      // If current tab is dev-only and devMode is turned off, switch to dashboard
      const devOnlyTabs = ['ir', 'raw_code', 'state', 'script', 'logs'] as const;
      if (!enabled && (devOnlyTabs as readonly string[]).includes(appState.local.settings.activeTab)) {
        appState.local.settings.activeTab = 'dashboard';
      }
    });
    this.saveSettings();
  }

  public setApiKey(key: string | undefined) {
    runInAction(() => {
      appState.local.settings.apiKey = key;
    });
    this.saveSettings();
  }

  public setLeftPanelCollapsed(collapsed: boolean) {
    runInAction(() => {
      appState.local.settings.leftPanelCollapsed = collapsed;
    });
    this.saveSettings();
  }

  public setLeftPanelWidth(width: number) {
    runInAction(() => {
      appState.local.settings.leftPanelWidth = width;
    });
    this.saveSettings();
  }

  public setChatPanelWidth(width: number) {
    runInAction(() => {
      appState.local.settings.chatPanelWidth = width;
    });
    this.saveSettings();
  }

  public toggleLeftPanel(tabId: AppSettings['activeTab']) {
    runInAction(() => {
      if (appState.local.settings.activeTab === tabId && !appState.local.settings.leftPanelCollapsed) {
        // Clicking active tab -> collapse
        appState.local.settings.leftPanelCollapsed = true;
      } else {
        // Clicking different tab or panel is collapsed -> open to that tab
        appState.local.settings.activeTab = tabId;
        appState.local.settings.leftPanelCollapsed = false;
      }
    });
    this.saveSettings();
  }

  private saveSettings() {
    if (!settingsManager.settingsLoaded) return; // Don't stomp persisted settings with defaults
    settingsManager.saveSettings(toJS(appState.local.settings));
  }

  private saveInputDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  public saveInputValue(id: string, value: any) {
    runInAction(() => {
      if (!appState.database.savedInputValues) {
        appState.database.savedInputValues = {};
      }
      appState.database.savedInputValues[id] = value;
    });
    // Debounce database save for rapid slider changes
    if (this.saveInputDebounceTimer) clearTimeout(this.saveInputDebounceTimer);
    this.saveInputDebounceTimer = setTimeout(() => {
      this.saveDatabaseWithTimestamp();
      this.saveInputDebounceTimer = null;
    }, 300);
  }

  public async saveInputFile(id: string, file: File) {
    const saved: SavedInputFile = {
      name: file.name,
      mimeType: file.type,
      blob: file,
    };
    await settingsManager.saveInputFile(this.activeWorkspaceId, id, saved);
  }

  /**
   * Returns the set of input IDs that have saved file data in IndexedDB.
   * Called before setCompiled so we can skip loading default textures for those.
   */
  public async getSavedFileInputIds(): Promise<Set<string>> {
    const savedFiles = await settingsManager.loadAllInputFiles(this.activeWorkspaceId);
    return new Set(savedFiles.keys());
  }

  public async restoreSavedInputs() {
    const savedValues = appState.database.savedInputValues;
    const entries = this.runtime.inputEntries;

    // Restore scalar values
    if (savedValues) {
      for (const [id, value] of Object.entries(savedValues)) {
        const entry = entries.get(id);
        if (entry && entry.type !== RuntimeInputType.Texture) {
          this.runtime.setInput(id, value);
        }
      }
    }

    // Restore file inputs
    const savedFiles = await settingsManager.loadAllInputFiles(this.activeWorkspaceId);
    for (const [id, savedFile] of savedFiles) {
      const entry = entries.get(id);
      if (entry && entry.type === RuntimeInputType.Texture) {
        try {
          const file = new File([savedFile.blob], savedFile.name, { type: savedFile.mimeType });
          this.runtime.setTextureSource(id, { type: 'file', value: file });
        } catch (e) {
          console.warn(`Failed to restore saved file for input ${id}:`, e);
        }
      }
    }
  }

  public setChatOpen(open: boolean) {
    runInAction(() => {
      appState.local.settings.chatOpen = open;
    });
    this.saveSettings();
  }

  public toggleMockLLM(useMock: boolean) {
    runInAction(() => {
      appState.local.settings.useMockLLM = useMock;
    });
    this.saveSettings();
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

  /** Sync cached workspace index fields from live IR state. */
  private syncWorkspaceIndex() {
    const ws = appState.local.workspaces.find(w => w.id === this.activeWorkspaceId);
    if (!ws) return;
    const comment = appState.database.ir.comment || undefined;
    if (ws.comment !== comment) {
      runInAction(() => { ws.comment = comment; });
    }
    return ws;
  }

  /** Persist database to IDB without touching updatedAt. */
  private saveDatabase() {
    if (!this.activeWorkspaceId) return;
    this.syncWorkspaceIndex();
    settingsManager.saveDatabase(toJS(appState.database), this.activeWorkspaceId);
    const ws = appState.local.workspaces.find(w => w.id === this.activeWorkspaceId);
    if (ws) settingsManager.saveWorkspace(toJS(ws));
  }

  /** Persist database AND bump the workspace's updatedAt (for real content changes). */
  private saveDatabaseWithTimestamp() {
    if (!this.activeWorkspaceId) return;
    this.syncWorkspaceIndex();
    settingsManager.saveDatabase(toJS(appState.database), this.activeWorkspaceId);
    const ws = appState.local.workspaces.find(w => w.id === this.activeWorkspaceId);
    if (ws) {
      runInAction(() => { ws.updatedAt = Date.now(); });
      settingsManager.saveWorkspace(toJS(ws));
    }
  }

  public undo() {
    historyManager.undo();
    this.saveDatabaseWithTimestamp();
    this.performCompile();
  }

  public redo() {
    historyManager.redo();
    this.saveDatabaseWithTimestamp();
    this.performCompile();
  }

  public clearLogs() {
    runInAction(() => {
      appState.local.llmLogs.length = 0;
    });
  }

  public setMaxLLMTurns(turns: number) {
    runInAction(() => {
      appState.local.settings.maxLLMTurns = Math.max(1, Math.min(100, turns));
    });
    this.saveSettings();
  }

  public setLLMBusy(busy: boolean) {
    runInAction(() => {
      appState.local.llmBusy = busy;
      if (!busy) {
        appState.local.llmStatus = undefined;
      }
    });
  }

  public setLLMStatus(status: string | null) {
    runInAction(() => {
      appState.local.llmStatus = status ?? undefined;
    });
  }

  public setCompileStatus(status: 'success' | 'fail' | 'compiling') {
    runInAction(() => {
      appState.local.compileStatus = status;
      if (status === 'success') {
        appState.local.lastCompileTime = Date.now();
      }
    });
  }

  public isIRStale(): boolean {
    const irJson = JSON.stringify(appState.database.ir);
    return irJson !== this.lastCompiledIRJson;
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

  public debugValidateCurrentIR() {
    console.info("[AppController] Validating IR...");
    const ir = appState.database.ir;
    const errors = validateIR(ir);
    console.log('[Validate] Manual validation found', errors.length, 'errors');
    runInAction(() => {
      appState.local.validationErrors = errors;
      if (errors.length) {
        this.setActiveTab('raw_code');
      }
    });
    return !errors.length;
  }

  public async play() {
    // Always set transport state to playing (reflects user intent)
    runInAction(() => {
      appState.local.settings.transportState = 'playing';
    });
    this.saveSettings();

    // Try to compile and start playback if possible
    const compiled = await this.ensureCompiled();
    // Only start runtime if we're still in playing state (user may have stopped in the meantime)
    if (compiled && appState.local.settings.transportState === 'playing') {
      this.runtime.play();
    }
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
      this.saveDatabaseWithTimestamp();
    });

    if (options?.needsCompile) {
      task.compileResult = this.performCompile();
    }

    return task;
  }

  public async ensureCompiled() {
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

  public async performCompile(): Promise<CompileResult> {
    // 1. Cancel previous in-flight compilation
    if (this.activeCompileResolver) {
      this.activeCompileResolver({ compileStatus: 'timeout' });
      this.activeCompileResolver = null;
    }

    // 2. Check for redundant work
    const ir = appState.database.ir;
    const irJson = JSON.stringify(ir);
    if (irJson === this.lastCompiledIRJson) {
      runInAction(() => {
        appState.local.validationErrors = [];
      });
      this.setCompileStatus('success');
      return { compileStatus: 'success' };
    }

    // 3. Start new compilation task
    this.setCompileStatus('compiling');
    this.activeCompilePromise = new Promise<CompileResult>(async (resolve) => {
      this.activeCompileResolver = resolve;

      // Local timeout for THIS specific turn
      const timeoutTimer = setTimeout(() => {
        if (this.activeCompileResolver === resolve) {
          resolve({ compileStatus: 'timeout' });
          this.activeCompileResolver = null;
        }
      }, 10000);

      const artifacts = await this.repl.compile(ir);
      const errors = artifacts ? [] : toJS(this.repl.validationErrors);

      // Only apply side effects if we haven't been superseded or timed out
      if (this.activeCompileResolver === resolve) {
        clearTimeout(timeoutTimer);

        if (artifacts) {
          this.repl.swap(artifacts);

          try {
            const device = await getSharedDevice();
            const savedFileIds = await this.getSavedFileInputIds();
            await this.runtime.setCompiled(artifacts, device, savedFileIds);
            await this.restoreSavedInputs();
          } catch (gpuError) {
            console.warn("[AppController] GPU environment not available for live update:", gpuError);
          }

          runInAction(() => {
            appState.local.compilationResult = {
              js: artifacts.compiled.taskCode,
              jsInit: artifacts.compiled.initCode,
              wgsl: artifacts.wgsl
            };
            appState.local.validationErrors = [];
          });

          this.lastCompiledIRJson = irJson;
          this.setCompileStatus('success');
        } else {
          runInAction(() => {
            appState.local.validationErrors = errors;
          });
          this.setCompileStatus('fail');
        }

        const res: CompileResult = artifacts
          ? { compileStatus: 'success' }
          : { compileStatus: 'fail', errors };
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
      this.saveDatabaseWithTimestamp();
    });
  }

  // --- Workspace Methods ---

  public async createWorkspace(name?: string): Promise<string> {
    const now = Date.now();
    const id = crypto.randomUUID();
    const entry: WorkspaceIndexEntry = {
      id,
      name: name || 'New Shader',
      createdAt: now,
      updatedAt: now,
    };
    await settingsManager.saveWorkspace(entry);
    await settingsManager.saveDatabase(JSON.parse(JSON.stringify(INITIAL_DATABASE_STATE)), id);

    runInAction(() => {
      appState.local.workspaces.unshift(entry);
    });

    return id;
  }

  public async forkWorkspace(sourceId: string): Promise<string> {
    const sourceEntry = appState.local.workspaces.find(w => w.id === sourceId);
    if (!sourceEntry) throw new Error('Workspace not found');

    // If forking the active workspace, use the live state
    let sourceData: DatabaseState;
    if (sourceId === this.activeWorkspaceId) {
      sourceData = JSON.parse(JSON.stringify(toJS(appState.database)));
    } else {
      const loaded = await settingsManager.loadDatabase(sourceId);
      if (!loaded) throw new Error('Workspace data not found');
      sourceData = loaded;
    }

    const now = Date.now();
    const newId = crypto.randomUUID();
    const entry: WorkspaceIndexEntry = {
      id: newId,
      name: `${sourceEntry.name} (Fork)`,
      createdAt: now,
      updatedAt: now,
      forkedFrom: {
        sourceId: sourceId,
        sourceName: sourceEntry.name,
        forkedAt: now,
      },
    };
    await settingsManager.saveWorkspace(entry);
    await settingsManager.saveDatabase(sourceData, newId);

    // Copy input files
    const inputFiles = await settingsManager.loadAllInputFiles(sourceId);
    for (const [inputId, file] of inputFiles) {
      await settingsManager.saveInputFile(newId, inputId, file);
    }

    runInAction(() => {
      appState.local.workspaces.unshift(entry);
    });

    return newId;
  }

  public async deleteWorkspace(id: string): Promise<void> {
    // Delete the data
    await settingsManager.deleteWorkspace(id);
    await settingsManager.deleteWorkspaceData(id);

    runInAction(() => {
      const idx = appState.local.workspaces.findIndex(w => w.id === id);
      if (idx !== -1) appState.local.workspaces.splice(idx, 1);
    });

    // If we deleted the active workspace, switch to another or create a new one
    if (id === this.activeWorkspaceId) {
      if (appState.local.workspaces.length > 0) {
        await this.switchWorkspace(appState.local.workspaces[0].id);
      } else {
        // Create a fresh default workspace
        const newId = await this.createWorkspace('New Shader');
        await this.switchWorkspace(newId);
      }
    }
  }

  public async renameWorkspace(id: string, name: string): Promise<void> {
    const entry = appState.local.workspaces.find(w => w.id === id);
    if (!entry || entry.name === name) return;

    runInAction(() => {
      entry.name = name;
      entry.updatedAt = Date.now();
    });
    await settingsManager.saveWorkspace(toJS(entry));
  }

  public setWorkspaceComment(comment: string): void {
    const current = appState.database.ir.comment || '';
    if (current === comment) return;

    this.mutate('Update comment', 'user', (draft) => {
      draft.ir.comment = comment || undefined;
    });
  }

  public async switchWorkspace(targetId: string): Promise<void> {
    if (targetId === this.activeWorkspaceId) return;

    // 1. Save current workspace
    this.saveDatabase();

    // 2. Abort in-flight LLM
    _chatHandler?.stop();

    // 3. Clear undo/redo history
    historyManager.clear();

    // 4. Stop runtime
    this.runtime.stop();

    // 5. Load target workspace data
    const targetData = await settingsManager.loadDatabase(targetId);
    const data = targetData || JSON.parse(JSON.stringify(INITIAL_DATABASE_STATE));

    runInAction(() => {
      // Replace database state
      Object.keys(appState.database).forEach(key => {
        delete (appState.database as any)[key];
      });
      Object.assign(appState.database, data);

      // Reset ephemeral state
      appState.local.validationErrors = [];
      appState.local.compilationResult = undefined;
      appState.local.compileStatus = undefined;
      appState.local.draftChat = '';
      appState.local.activeRewindId = null;
      appState.local.selectedEntity = undefined;
      appState.local.selectionHistory = [];
      appState.local.selectionFuture = [];
      appState.local.llmBusy = false;
      appState.local.llmStatus = undefined;

      // Update active workspace
      appState.local.settings.activeWorkspaceId = targetId;
    });

    // Sync cached fields (comment) from the now-loaded IR into the workspace index
    this.syncWorkspaceIndex();

    // 6. Persist settings
    this.saveSettings();

    // 7. Reset compilation state and recompile
    this.lastCompiledIRJson = null;
    this.repl.currentArtifacts = null;
    await this.restoreTransportState();
  }
}

export const appController = new AppController();
