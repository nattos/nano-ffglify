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
import { DatabaseState, LocalState } from './types';
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
        activeTab: 'dashboard',
        chatOpen: true,
        useMockLLM: false,
        transportState: 'playing',
        devMode: false,
      },
      llmLogs: [],
      llmBusy: false,
      draftChat: '',
      activeRewindId: null,
      selectedEntity: undefined,
      selectionHistory: [],
      selectionFuture: [],
      validationErrors: [],
      compilationResult: undefined
    } as any);

    makeObservable(this, {
      database: observable,
      local: observable
    });

    // Load settings async
    this.initialized = Promise.all([
      this.loadSettings(),
      this.initPersistence()
    ]).then(() => { });
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
    const savedDb = await settingsManager.loadDatabase();
    if (savedDb) {
      runInAction(() => {
        // Merge or replace. Since it's a snapshot, replacing properties is safer.
        Object.assign(this.database, savedDb);
      });
    }

  }
}

export const appState = new AppState();
