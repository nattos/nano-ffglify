/**
 * @file entity-manager.ts
 * @description Abstraction layer for CRUD operations on Database Entities.
 * Translates intent (e.g., "upsert entity", "patch entity") into Immer recipes and calls `appController.mutate`.
 *
 * @external-interactions
 * - Used by `chat-handler.ts` to execute LLM tool calls.
 * - Used by `controller.ts` (though typically the other way around).
 *
 * @pitfalls
 * - Uses `fast-json-patch`. Ensure paths are correct JSON Pointers (e.g., `/refs/-` to append to array).
 * - `mutate` call is synchronous; validation should happen BEFORE calling these methods.
 */
import { applyPatch } from 'fast-json-patch';
import { appState, AppState } from '../domain/state';
import { AppController, appController } from './controller';
import { toJS } from 'mobx';
import {
  EntityResponse,
  UpsertEntityRequest,
  DeleteEntityRequest,
  PatchEntityRequest,
  MutationResult
} from './entity-api';
import { Note } from '../domain/types';
import { validateEntity } from '../domain/verifier';

export class EntityManager {
  constructor(
    private appState: AppState,
    private controller: AppController
  ) { }

  public upsertEntity(request: UpsertEntityRequest<Note>): EntityResponse {
    const { entity_type, entity } = request;
    const id = entity.id || crypto.randomUUID();

    if (entity_type !== 'Note') {
      return { success: false, message: "Only Notes are supported" };
    }

    // 1. Resolve Existing
    let existing: any = toJS(this.appState.database.notes[id] || {});
    const exists = !!existing.id;

    // 2. Propose Merge
    const timestamp = Date.now();
    const merged: Note = {
      ...existing,
      ...entity,
      id,
      updated_at: timestamp,
      created_at: existing.created_at || timestamp,
      refs: entity.refs || existing.refs || [],
      body: entity.body || existing.body || ""
    } as Note;

    // 3. Verify Merged State
    const errors = validateEntity(merged as any, entity_type, this.appState.database);
    if (errors.length > 0) {
      const errorMsg = errors.map(e => `${e.field}: ${e.message} `).join('; ');
      return { success: false, message: `Validation Failed. ${errorMsg}`, errors };
    }

    // 4. Record History & Apply
    const operation = exists ? 'updated' : 'created';
    this.controller.mutate(`${operation} Note`, 'llm', (database) => {
      database.notes[id] = merged;
    });

    return {
      success: true,
      message: `Note ${operation}`,
      data: {
        entity_id: id,
        operation
      } as MutationResult
    };
  }

  public deleteEntity(request: DeleteEntityRequest): EntityResponse {
    if (request.entity_type !== 'Note') return { success: false, message: "Invalid type" };

    this.controller.mutate(`Delete Note`, 'llm', (database) => {
      delete database.notes[request.entity_id];
    });
    return { success: true, message: "Deleted" };
  }


  public patchEntity(request: PatchEntityRequest): EntityResponse {
    const { entity_type, entity_id, patches } = request;
    if (entity_type !== 'Note') return { success: false, message: "Invalid type" };

    const existing = this.appState.database.notes[entity_id];
    if (!existing) return { success: false, message: "Note not found" };

    this.controller.mutate(`Patch Note`, 'llm', (database) => {
      const target = database.notes[entity_id];
      if (!target) return;

      // fast-json-patch mutates the target in place
      try {
        applyPatch(target, patches as any);
        target.updated_at = Date.now();
      } catch (e: any) {
        console.error("Patch Failed:", e);
      }
    });

    return {
      success: true,
      message: "Patched",
      data: {
        entity_id,
        operation: 'updated'
      } as MutationResult
    };
  }

  public getCollectionName(type: string): string {
    return 'notes'; // Simple mapping
  }
}

export const entityManager = new EntityManager(appState, appController);
