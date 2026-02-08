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

  public async replaceIR(request: ReplaceIRRequest): Promise<IREditResponse> {
    const entity_type = 'IR';

    // 4. Record History & Apply
    const operation = 'replace';
    let editApplied = false;
    let validationErrors: ValidationError[] | undefined;
    let compilePromise: Promise<CompileResult> | undefined;

    try {
      const task = this.controller.mutate(`${operation} ${entity_type}`, 'llm', (database) => {
        database.ir = structuredClone(request);
        validationErrors = validateEntity(database.ir as any, 'IR', database);
        if (validationErrors.length) {
          throw new EditNotValidError();
        }
      }, { needsCompile: true });
      compilePromise = task.compileResult;
      editApplied = true;
    } catch (e) {
      if (e instanceof EditNotValidError) {
        validationErrors ??= [];
      } else {
        throw e;
      }
    }

    let compileResult: CompileResult | undefined;
    if (editApplied && compilePromise) {
      compileResult = await compilePromise;
    }

    return {
      editApplied: editApplied,
      message: `${entity_type} ${operation}`,
      validationResult: {
        success: editApplied,
        errors: validationErrors,
      },
      compileResult
    };
  }

  public async patchIR(request: PatchIRRequest): Promise<IREditResponse> {
    const entity_type = 'IR';
    const patches = request.patches;

    if (!Array.isArray(patches)) {
      return { editApplied: false, message: `patches must be an array` };
    }

    const operation = 'patch';
    let editApplied = false;
    let validationErrors: ValidationError[] | undefined;
    let compilePromise: Promise<CompileResult> | undefined;

    try {
      const task = this.controller.mutate(`Patch ${entity_type}`, 'llm', (database) => {
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
      }, { needsCompile: true });
      compilePromise = task.compileResult;
      editApplied = true;
    } catch (e) {
      if (e instanceof EditNotValidError) {
        validationErrors ??= [];
      } else {
        throw e;
      }
    }

    let compileResult: CompileResult | undefined;
    if (editApplied && compilePromise) {
      compileResult = await compilePromise;
    }

    return {
      editApplied: editApplied,
      message: `${entity_type} ${operation}`,
      validationResult: {
        success: editApplied,
        errors: validationErrors,
      },
      compileResult
    };
  }
}

export const entityManager = new EntityManager(appState, appController);
