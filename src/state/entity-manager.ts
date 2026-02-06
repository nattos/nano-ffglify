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
import {
  EntityResponse,
  ReplaceIRRequest,
  PatchIRRequest,
  MutationResult
} from './entity-api';
import { validateEntity } from '../domain/verifier';

export class EntityManager {
  constructor(
    private appState: AppState,
    private controller: AppController
  ) { }

  public replaceIR(request: ReplaceIRRequest): EntityResponse {
    const entity_type = 'IR';
    const errors = validateEntity(request as any, 'IR', this.appState.database);
    if (errors.length > 0) {
      const errorMsg = errors.map(e => `${e.field}: ${e.message} `).join('; ');
      return { success: false, message: `Validation Failed. ${errorMsg}`, errors };
    }

    // 4. Record History & Apply
    const operation = 'replace';
    this.controller.mutate(`${operation} ${entity_type}`, 'llm', (database) => {
      database.ir = structuredClone(request);
    });

    return {
      success: true,
      message: `${entity_type} ${operation}`,
      data: {
        operation: operation as string
      } as MutationResult
    };
  }

  public patchIR(request: PatchIRRequest): EntityResponse {
    const entity_type = 'IR';
    const patches = request;

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
        operation: 'updated'
      } as MutationResult
    };
  }
}

export const entityManager = new EntityManager(appState, appController);
