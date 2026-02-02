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
import { validateEntity } from '../domain/verifier';
import { IRDocument } from '../ir/types';

export class EntityManager {
  constructor(
    private appState: AppState,
    private controller: AppController
  ) { }

  public upsertEntity(request: UpsertEntityRequest<any>): EntityResponse {
    const { entity_type, entity } = request;
    const id = entity.id || 'current-ir';

    if (entity_type !== 'IR') {
      return { success: false, message: "Only IR is supported" };
    }

    // 1. Resolve Existing
    const existing: any = toJS(this.appState.database.ir || {});
    const exists = existing.id === id;

    // 2. Propose Merge
    const merged: IRDocument & { id: string } = {
      ...existing,
      ...entity,
      id
    };

    // 3. Verify Merged State
    const errors = validateEntity(merged as any, entity_type, this.appState.database);
    if (errors.length > 0) {
      const errorMsg = errors.map(e => `${e.field}: ${e.message} `).join('; ');
      return { success: false, message: `Validation Failed. ${errorMsg}`, errors };
    }

    // 4. Record History & Apply
    const operation = exists ? 'updated' : 'created';
    this.controller.mutate(`${operation} ${entity_type}`, 'llm', (database) => {
      database.ir = merged;
    });

    return {
      success: true,
      message: `${entity_type} ${operation}`,
      data: {
        entity_id: id,
        operation
      } as MutationResult
    };
  }

  public deleteEntity(request: DeleteEntityRequest): EntityResponse {
    if (request.entity_type !== 'IR') return { success: false, message: "Invalid type" };

    this.controller.mutate(`Delete ${request.entity_type}`, 'llm', (database) => {
      // For IR, we might want to reset to initial instead of deleting
      database.ir = { id: 'current-ir', version: '1.0', meta: { name: 'Empty IR' }, entryPoint: '', inputs: [], resources: [], structs: [], functions: [] };
    });
    return { success: true, message: "Reset IR" };
  }


  public patchEntity(request: PatchEntityRequest): EntityResponse {
    const { entity_type, entity_id, patches } = request;
    if (entity_type !== 'IR') return { success: false, message: "Invalid type" };

    const existing = this.appState.database.ir;
    if (!existing) return { success: false, message: "IR not found" };

    this.controller.mutate(`Patch ${entity_type}`, 'llm', (database) => {
      const target = database.ir;
      if (!target) return;

      try {
        applyPatch(target, patches as any);
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
    return 'ir';
  }
}

export const entityManager = new EntityManager(appState, appController);
