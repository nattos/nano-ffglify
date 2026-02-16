/**
 * @file history.ts
 * @description Manages the Undo/Redo stack using Immer Patches.
 * Records inverse patches for every mutation to allow time-travel.
 *
 * @external-interactions
 * - `record`: Called by `controller.mutate` to save a checkpoint.
 * - `undo`/`redo`: Called by UI buttons.
 *
 * @pitfalls
 * - History stack is in-memory only. It is lost on page reload.
 * - Does NOT affect the persisted Database snapshot (which is always "Latest").
 */
import { observable, action, runInAction, makeObservable } from 'mobx';
import { produce, Patch, enablePatches } from 'immer';
import { appState, AppState } from '../domain/state';
import { DatabaseState } from '../domain/types';

enablePatches();

export interface Mutation {
  id: string;
  description: string;
  source: 'user' | 'llm';
  patches: Patch[];
  inversePatches: Patch[];
  timestamp: number;
}

export class HistoryManager {
  public history: Mutation[] = observable([]);
  public redoStack: Mutation[] = observable([]);

  constructor(private appState: AppState) {
    makeObservable(this);
  }

  @action
  record(description: string, source: 'user' | 'llm', recipe: (draft: DatabaseState) => void) {
    let patches: Patch[] = [];
    let inversePatches: Patch[] = [];

    const nextState = produce(this.appState.database, recipe, (p, inv) => {
      patches = p;
      inversePatches = inv;
    });

    // Apply state change
    runInAction(() => {
      this.applyPatchesToObservable(this.appState.database, patches);
    });

    const mutation: Mutation = {
      id: crypto.randomUUID(),
      description,
      source,
      patches,
      inversePatches,
      timestamp: Date.now()
    };

    runInAction(() => {
      this.history.push(mutation);
      this.redoStack.length = 0; // Clear redo on new action
    });
  }

  @action
  undo() {
    const mutation = this.history.pop();
    if (!mutation) return;

    runInAction(() => {
      this.applyPatchesToObservable(this.appState.database, mutation.inversePatches);
      this.redoStack.push(mutation);
    });
  }

  @action
  redo() {
    const mutation = this.redoStack.pop();
    if (!mutation) return;

    runInAction(() => {
      this.applyPatchesToObservable(this.appState.database, mutation.patches);
      this.history.push(mutation);
    });
  }

  @action
  clear() {
    this.history.length = 0;
    this.redoStack.length = 0;
  }

  @action
  rejectLastLLMAction() {
    // Find last LLM action
    // For simplicity, just pop until we find one, or search backwards and undo strictly that?
    // True undo requires reverting strictly the patches. If subsequent actions depend on it, it gets messy.
    // For this POC, let's assume linear undo is fine, or we only reject if it was the last thing.

    // Linear search backwards
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].source === 'llm') {
        // If it's the very last one, easy.
        if (i === this.history.length - 1) {
          this.undo();
          return;
        }
        // If not, we technically need to rebase or warn.
        // For now, let's just console warn and do nothing to avoid data corruption.
        console.warn("Cannot reject older LLM action safely without rebase.");
        return;
      }
    }
  }

  // Helper to apply Immer patches to a MobX observable tree
  private applyPatchesToObservable(target: any, patches: Patch[]) {
    patches.forEach(patch => {
      const { path, op, value } = patch;
      let current = target;
      for (let i = 0; i < path.length - 1; i++) {
        current = current[path[i]];
      }
      const key = path[path.length - 1];

      if (op === 'replace' || op === 'add') {
        current[key] = value;
      } else if (op === 'remove') {
        if (Array.isArray(current)) {
          current.splice(key as number, 1);
        } else {
          delete current[key];
        }
      }
    });
  }
}

export const historyManager = new HistoryManager(appState);
