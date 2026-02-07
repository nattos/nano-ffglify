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
  IREditResponse,
  ReplaceIRRequest,
  PatchIRRequest,
  CompileResult
} from './entity-api';
import { validateEntity } from '../domain/verifier';
import { ValidationError } from '../domain/types';

class EditNotValidError extends Error { }

export class EntityManager {
  constructor(
    private appState: AppState,
    private controller: AppController
  ) { }

  public replaceIR(request: ReplaceIRRequest): IREditResponse {
    const entity_type = 'IR';

    // 4. Record History & Apply
    const operation = 'replace';
    let validationErrors: ValidationError[] | undefined;
    try {
      this.controller.mutate(`${operation} ${entity_type}`, 'llm', (database) => {
        database.ir = structuredClone(request);
        validationErrors = validateEntity(database.ir as any, 'IR', database);
        if (validationErrors.length) {
          throw new EditNotValidError();
        }
      });
    } catch (e) {
      if (e instanceof EditNotValidError) {
        validationErrors ??= [];
      } else {
        throw e;
      }
    }

    const editApplied = !validationErrors;
    return {
      editApplied: editApplied,
      message: `${entity_type} ${operation}`,
      validationResult: {
        success: editApplied,
        errors: validationErrors,
      }
    };
  }

  public patchIR(request: PatchIRRequest): IREditResponse {
    const entity_type = 'IR';
    const patches = request.patches;

    if (!Array.isArray(patches)) {
      return { editApplied: false, message: `patches must be an array` };
    }

    const operation = 'patch';
    let validationErrors: ValidationError[] | undefined;
    try {
      this.controller.mutate(`Patch ${entity_type}`, 'llm', (database) => {
        const target = database.ir;
        if (!target) return;

        try {
          applyPatch(target, patches as any);
          validationErrors = validateEntity(database.ir as any, 'IR', database);
        } catch (e: any) {
          console.error("Patch Failed:", e);
          validationErrors = [{
            field: '/',
            message: `Patch failed: ${e.toString()}`,
            severity: 'error'
          }];
        }
        if (validationErrors.length) {
          throw new EditNotValidError();
        }
      });
    } catch (e) {
      if (e instanceof EditNotValidError) {
        validationErrors ??= [];
      } else {
        throw e;
      }
    }

    const editApplied = !validationErrors;
    return {
      editApplied: editApplied,
      message: `${entity_type} ${operation}`,
      validationResult: {
        success: editApplied,
        errors: validationErrors,
      }
    };
  }
}

export const entityManager = new EntityManager(appState, appController);
