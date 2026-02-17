/**
 * @file state.ts
 * @description The root container for the application state (MobX).
 * Defines the `AppState` class which holds both persisted `database` and ephemeral `local` state.
 *
 * @external-interactions
 * - Roots the entire Reactivity tree.
 * - `initPersistence` connects to `SettingsManager` to load data on startup.
 *
 * @pitfalls
 * - `database` is serialized to IndexedDB; avoid putting non-serializable objects (like Functions or class instances) here. Use plain objects.
 * - `local` state is NOT persisted by default (except for settings).
 */
import { observable, makeObservable, configure, runInAction } from 'mobx';
import { enableMapSet, setAutoFreeze } from 'immer';
import { DatabaseState, LocalState, WorkspaceIndexEntry } from './types';
import { settingsManager } from '../state/settings';
import { INITIAL_DATABASE_STATE } from './init';

// Enable Immer support
enableMapSet();
setAutoFreeze(false);

configure({
  enforceActions: "always",
  computedRequiresReaction: true,
  reactionRequiresObservable: false,
  observableRequiresReaction: false,
});

export class AppState {
  // Observability is *only* for display purposes. Logic should not rely on reactions to this field.
  public database: DatabaseState;
  public local: LocalState;
  public initialized: Promise<void>;

  constructor(initialDatabaseState?: DatabaseState) {
    this.database = observable(initialDatabaseState || INITIAL_DATABASE_STATE);

    this.local = observable({
      settings: {
        activeTab: 'workspaces',
        chatOpen: true,
        useMockLLM: false,
        transportState: 'playing',
        devMode: false,
      },
      llmLogs: [],
      llmBusy: false,
      draftChat: '',
      draftImages: [],
      activeRewindId: null,
      selectedEntity: undefined,
      selectionHistory: [],
      selectionFuture: [],
      draftExampleKey: null,
      validationErrors: [],
      compilationResult: undefined,
      workspaces: [],
    } as any);

    makeObservable(this, {
      database: observable,
      local: observable
    });

    // Load settings FIRST, then database.
    // Settings must be loaded before anything else runs, because processes
    // triggered by database load can save default settings that stomp real ones.
    this.initialized = this.loadSettings().then(() => this.initPersistence());
  }

  async loadSettings() {
    const saved = await settingsManager.loadSettings();
    if (saved && this.local['settings']) {
      // Migrate legacy tab values
      if ((saved as any).activeTab === 'live') {
        saved.activeTab = 'dashboard';
      }
      // Ensure devMode has a default
      if (saved.devMode === undefined) {
        saved.devMode = false;
      }
      runInAction(() => {
        Object.assign(this.local['settings'], saved);
      });
    }
  }

  async initPersistence() {
    // Run v1→v2 migration if needed
    await settingsManager.runMigrationIfNeeded();

    // Load workspace index
    const workspaces = await settingsManager.listWorkspaces();

    // Resolve active workspace
    let activeId = this.local.settings.activeWorkspaceId;

    if (!activeId || !workspaces.find(w => w.id === activeId)) {
      // Fall back to most recent workspace
      if (workspaces.length > 0) {
        activeId = workspaces[0].id; // Already sorted by updatedAt desc
      }
    }

    // If no workspaces exist, create a default one
    if (!activeId || workspaces.length === 0) {
      const now = Date.now();
      const newId = crypto.randomUUID();
      const entry: WorkspaceIndexEntry = {
        id: newId,
        name: 'New Shader',
        createdAt: now,
        updatedAt: now,
      };
      await settingsManager.saveWorkspace(entry);
      await settingsManager.saveDatabase(JSON.parse(JSON.stringify(INITIAL_DATABASE_STATE)), newId);
      workspaces.push(entry);
      activeId = newId;
    }

    // Load the active workspace's data
    const savedDb = await settingsManager.loadDatabase(activeId);
    runInAction(() => {
      this.local.workspaces = workspaces;
      this.local.settings.activeWorkspaceId = activeId;
      if (savedDb) {
        Object.assign(this.database, savedDb);
        // Sync cached comment from loaded IR into workspace index
        const ws = workspaces.find(w => w.id === activeId);
        if (ws) {
          ws.comment = savedDb.ir?.comment || undefined;
        }
      }
    });

    // Persist the active workspace ID
    settingsManager.saveSettings({ ...this.local.settings } as any);
  }
}

export const appState = new AppState();
