/**
 * @file settings.ts
 * @description Handles IndexedDB Persistence for the application.
 * Manages stores: 'settings' (local UI prefs), 'database_snapshot' (per-workspace content),
 * 'input_files' (per-workspace file inputs), and 'workspaces' (workspace index).
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
import { AppSettings, DatabaseState, SavedInputFile, WorkspaceIndexEntry } from '../domain/types';
import { Resolvable } from '../utils/utils';
import { AUTO_PLAY_SCRIPT_LINES } from '../constants';

export type LocalSettings = AppSettings;
// Use env variable, _without_ a fallback. This can and should error if not set.
// This prevents us from forking the template, only to stomp another app's settings
// unwittingly, potentially forever.
const DB_NAME = import.meta.env.VITE_DB_NAME;
const SETTINGS_STORE = 'settings';
const DB_SNAPSHOT_STORE = 'database_snapshot';
const INPUT_FILES_STORE = 'input_files';
const WORKSPACES_STORE = 'workspaces';
const DB_VERSION = 2;

interface AppDB extends DBSchema {
  settings: {
    key: string;
    value: LocalSettings;
  };
  database_snapshot: {
    key: string;
    value: DatabaseState;
  };
  input_files: {
    key: string;
    value: SavedInputFile;
  };
  workspaces: {
    key: string;
    value: WorkspaceIndexEntry;
  };
}

export class SettingsManager {
  private dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;
  public readonly databaseLoaded = new Resolvable<void>();
  private _settingsLoaded = false;

  /** True once settings have been loaded from IndexedDB (or confirmed absent). */
  get settingsLoaded(): boolean { return this._settingsLoaded; }

  constructor() {
    if (typeof indexedDB !== 'undefined' && DB_NAME) {
      this.dbPromise = openDB<AppDB>(DB_NAME, DB_VERSION, {
        upgrade(db: IDBPDatabase<AppDB>, oldVersion: number) {
          if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
            db.createObjectStore(SETTINGS_STORE);
          }
          if (!db.objectStoreNames.contains(DB_SNAPSHOT_STORE)) {
            db.createObjectStore(DB_SNAPSHOT_STORE);
          }
          if (!db.objectStoreNames.contains(INPUT_FILES_STORE)) {
            db.createObjectStore(INPUT_FILES_STORE);
          }
          if (!db.objectStoreNames.contains(WORKSPACES_STORE)) {
            db.createObjectStore(WORKSPACES_STORE);
          }
        },
      });
    } else {
      this.databaseLoaded.resolve();
    }
  }

  /**
   * Migrates v1 data (single 'latest' key) to workspace-scoped storage.
   * Safe to call multiple times — uses a flag in settings to track completion.
   */
  public async runMigrationIfNeeded(): Promise<void> {
    if (!this.dbPromise) return;
    try {
      const db = await this.dbPromise;

      // Check if migration already ran
      const settings = await db.get(SETTINGS_STORE, 'localSettings') as any;
      if (settings?.migrationVersion >= 2) return;

      // Read the legacy 'latest' key
      const legacyData = await db.get(DB_SNAPSHOT_STORE, 'latest');
      if (!legacyData) {
        // No legacy data — fresh install, just mark migration done
        const updated = { ...(settings || {}), migrationVersion: 2 };
        await db.put(SETTINGS_STORE, updated as any, 'localSettings');
        return;
      }

      const workspaceId = crypto.randomUUID();
      const now = Date.now();
      const name = legacyData.ir?.meta?.name || 'Untitled';

      // Create workspace index entry
      const entry: WorkspaceIndexEntry = {
        id: workspaceId,
        name,
        createdAt: now,
        updatedAt: now,
      };

      // Move savedInputValues from settings into DatabaseState
      const migratedData: DatabaseState = {
        ...legacyData,
        savedInputValues: (settings as any)?.savedInputValues || {},
      };

      // Write workspace entry and migrated data
      await db.put(WORKSPACES_STORE, entry, workspaceId);
      await db.put(DB_SNAPSHOT_STORE, migratedData, workspaceId);

      // Re-key input_files with workspace prefix
      const inputKeys = await db.getAllKeys(INPUT_FILES_STORE);
      for (const key of inputKeys) {
        const strKey = key as string;
        if (strKey.includes('/')) continue; // Already prefixed
        const file = await db.get(INPUT_FILES_STORE, strKey);
        if (file) {
          await db.put(INPUT_FILES_STORE, file, `${workspaceId}/${strKey}`);
          await db.delete(INPUT_FILES_STORE, strKey);
        }
      }

      // Delete legacy key
      await db.delete(DB_SNAPSHOT_STORE, 'latest');

      // Update settings with activeWorkspaceId and migration flag
      const updatedSettings = {
        ...(settings || {}),
        activeWorkspaceId: workspaceId,
        migrationVersion: 2,
      };
      // Remove savedInputValues from settings (now per-workspace)
      delete (updatedSettings as any).savedInputValues;
      await db.put(SETTINGS_STORE, updatedSettings as any, 'localSettings');

      console.info('[SettingsManager] Migrated v1 data to workspace:', workspaceId);
    } catch (e) {
      console.error('[SettingsManager] Migration error:', e);
    }
  }

  public async saveSettings(settings: LocalSettings): Promise<void> {
    if (!this._settingsLoaded) {
      throw new Error('Attempted to save settings before they were loaded. This would stomp persisted settings with defaults.');
    }
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
    if (!this.dbPromise) {
      this._settingsLoaded = true;
      throw new Error("Database not initialized. Check VITE_DB_NAME.");
    }
    try {
      const db = await this.dbPromise;
      const result = (await db.get(SETTINGS_STORE, 'localSettings')) || null;
      this._settingsLoaded = true;
      return result;
    } catch (e) {
      this._settingsLoaded = true;
      console.error('Error loading settings:', e);
      throw e;
    }
  }

  public async saveDatabase(state: DatabaseState, workspaceId: string): Promise<void> {
    // If auto-playing script, disable DB persistence to ensure clean state
    if (typeof AUTO_PLAY_SCRIPT_LINES === 'number') return;

    if (!this.dbPromise) return;
    try {
      const db = await this.dbPromise;
      await db.put(DB_SNAPSHOT_STORE, state, workspaceId);
    } catch (e) {
      console.error('Error saving database snapshot:', e);
    }
  }

  public async saveInputFile(workspaceId: string, id: string, file: SavedInputFile): Promise<void> {
    if (!this.dbPromise) return;
    try {
      const db = await this.dbPromise;
      await db.put(INPUT_FILES_STORE, file, `${workspaceId}/${id}`);
    } catch (e) {
      console.error('Error saving input file:', e);
    }
  }

  public async loadInputFile(workspaceId: string, id: string): Promise<SavedInputFile | null> {
    if (!this.dbPromise) return null;
    try {
      const db = await this.dbPromise;
      return (await db.get(INPUT_FILES_STORE, `${workspaceId}/${id}`)) || null;
    } catch (e) {
      console.error('Error loading input file:', e);
      return null;
    }
  }

  public async loadAllInputFiles(workspaceId: string): Promise<Map<string, SavedInputFile>> {
    const result = new Map<string, SavedInputFile>();
    if (!this.dbPromise) return result;
    try {
      const db = await this.dbPromise;
      const prefix = `${workspaceId}/`;
      const keys = await db.getAllKeys(INPUT_FILES_STORE);
      for (const key of keys) {
        const strKey = key as string;
        if (!strKey.startsWith(prefix)) continue;
        const file = await db.get(INPUT_FILES_STORE, strKey);
        if (file) result.set(strKey.slice(prefix.length), file);
      }
    } catch (e) {
      console.error('Error loading input files:', e);
    }
    return result;
  }

  public async loadDatabase(workspaceId: string): Promise<DatabaseState | null> {
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
      const data = await db.get(DB_SNAPSHOT_STORE, workspaceId);
      this.databaseLoaded.resolve();
      return data || null;
    } catch (e) {
      console.error('Error loading database snapshot:', e);
      this.databaseLoaded.resolve(); // Resolve anyway to not block app
      return null;
    }
  }

  // --- Workspace CRUD ---

  public async listWorkspaces(): Promise<WorkspaceIndexEntry[]> {
    if (!this.dbPromise) return [];
    try {
      const db = await this.dbPromise;
      const keys = await db.getAllKeys(WORKSPACES_STORE);
      const entries: WorkspaceIndexEntry[] = [];
      for (const key of keys) {
        const entry = await db.get(WORKSPACES_STORE, key as string);
        if (entry) entries.push(entry);
      }
      // Sort by updatedAt descending (most recent first)
      entries.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
      return entries;
    } catch (e) {
      console.error('Error listing workspaces:', e);
      return [];
    }
  }

  public async saveWorkspace(entry: WorkspaceIndexEntry): Promise<void> {
    if (!this.dbPromise) return;
    try {
      const db = await this.dbPromise;
      await db.put(WORKSPACES_STORE, entry, entry.id);
    } catch (e) {
      console.error('Error saving workspace:', e);
    }
  }

  public async deleteWorkspace(id: string): Promise<void> {
    if (!this.dbPromise) return;
    try {
      const db = await this.dbPromise;
      await db.delete(WORKSPACES_STORE, id);
    } catch (e) {
      console.error('Error deleting workspace:', e);
    }
  }

  public async deleteWorkspaceData(id: string): Promise<void> {
    if (!this.dbPromise) return;
    try {
      const db = await this.dbPromise;
      // Delete database snapshot
      await db.delete(DB_SNAPSHOT_STORE, id);
      // Delete associated input files
      const prefix = `${id}/`;
      const keys = await db.getAllKeys(INPUT_FILES_STORE);
      for (const key of keys) {
        if ((key as string).startsWith(prefix)) {
          await db.delete(INPUT_FILES_STORE, key);
        }
      }
    } catch (e) {
      console.error('Error deleting workspace data:', e);
    }
  }
}

export const settingsManager = new SettingsManager();
