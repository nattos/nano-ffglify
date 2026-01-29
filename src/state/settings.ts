/**
 * @file settings.ts
 * @description Handles IndexedDB Persistence for the application.
 * Manages two stores: 'settings' (local UI prefs) and 'database_snapshot' (content).
 *
 * @external-interactions
 * - `saveDatabase`: Called by `controller.ts` after mutations.
 * - `loadDatabase`: Called by `state.ts` on startup.
 *
 * @pitfalls
 * - Persistence is DISABLED if `AUTO_PLAY_SCRIPT_LINES` is set in `constants.ts` (to protect test/demo purity).
 * - Requires `VITE_DB_NAME` env var to function; throws otherwise.
 */
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { AppSettings, DatabaseState } from '../domain/types';
import { Resolvable } from '../utils/utils';
import { AUTO_PLAY_SCRIPT_LINES } from '../constants';

export type LocalSettings = AppSettings;
// Use env variable, _without_ a fallback. This can and should error if not set.
// This prevents us from forking the template, only to stomp another app's settings
// unwittingly, potentially forever.
const DB_NAME = import.meta.env.VITE_DB_NAME;
const SETTINGS_STORE = 'settings';
const DB_SNAPSHOT_STORE = 'database_snapshot';
const DB_VERSION = 1; // Incremented for new store

interface AppDB extends DBSchema {
  settings: {
    key: string;
    value: LocalSettings;
  };
  database_snapshot: {
    key: string;
    value: DatabaseState;
  };
}

export class SettingsManager {
  private dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;
  public readonly databaseLoaded = new Resolvable<void>();

  constructor() {
    if (typeof indexedDB !== 'undefined' && DB_NAME) {
      this.dbPromise = openDB<AppDB>(DB_NAME, DB_VERSION, {
        upgrade(db: IDBPDatabase<AppDB>) {
          if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
            db.createObjectStore(SETTINGS_STORE);
          }
          if (!db.objectStoreNames.contains(DB_SNAPSHOT_STORE)) {
            db.createObjectStore(DB_SNAPSHOT_STORE);
          }
        },
      });
    } else {
      this.databaseLoaded.resolve();
    }
  }

  public async saveSettings(settings: LocalSettings): Promise<void> {
    if (!this.dbPromise) throw new Error("Database not initialized. Check VITE_DB_NAME.");
    try {
      const db = await this.dbPromise;
      await db.put(SETTINGS_STORE, settings, 'localSettings');
    } catch (e) {
      console.error('Error saving settings:', e);
      throw e;
    }
  }

  public async loadSettings(): Promise<LocalSettings | null> {
    if (!this.dbPromise) throw new Error("Database not initialized. Check VITE_DB_NAME.");
    try {
      const db = await this.dbPromise;
      return (await db.get(SETTINGS_STORE, 'localSettings')) || null;
    } catch (e) {
      console.error('Error loading settings:', e);
      throw e;
    }
  }

  public async saveDatabase(state: DatabaseState): Promise<void> {
    // If auto-playing script, disable DB persistence to ensure clean state
    if (typeof AUTO_PLAY_SCRIPT_LINES === 'number') return;

    if (!this.dbPromise) return;
    try {
      const db = await this.dbPromise;
      // Persist the entire database state to a single key.
      // IDB handles structured cloning, so we don't strictly need toJS() if the state is clean,
      // but the caller (AppController) should ensure we receive a POJO.
      await db.put(DB_SNAPSHOT_STORE, state, 'latest');
    } catch (e) {
      console.error('Error saving database snapshot:', e);
    }
  }

  public async loadDatabase(): Promise<DatabaseState | null> {
    // If auto-playing script, disable DB persistence to ensure clean state
    if (typeof AUTO_PLAY_SCRIPT_LINES === 'number') {
      this.databaseLoaded.resolve();
      return null;
    }

    if (!this.dbPromise) {
      this.databaseLoaded.resolve();
      return null;
    }
    try {
      const db = await this.dbPromise;
      const data = await db.get(DB_SNAPSHOT_STORE, 'latest');
      this.databaseLoaded.resolve();
      return data || null;
    } catch (e) {
      console.error('Error loading database snapshot:', e);
      this.databaseLoaded.resolve(); // Resolve anyway to not block app
      return null;
    }
  }
}

export const settingsManager = new SettingsManager();
