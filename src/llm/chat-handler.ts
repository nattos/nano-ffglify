/**
 * @file chat-handler.ts
 * @description The "Brain" of the application. Manages the conversation loop:
 * User Input -> Prompt Building -> LLM API -> Response Parsing -> Tool Execution -> State Mutation.
 *
 * @external-interactions
 * - Calls `PromptBuilder` to format context.
 * - Calls `LLMManager` to hit the Gemini API.
 * - Calls `EntityManager` to apply tool side-effects.
 *
 * @pitfalls
 * - The `MAX_TURNS` loop prevents infinite tool recursion, but can fail complex multi-step tasks if too small.
 * - Tool arguments are not strictly typed at runtime unless `validateEntity` catches them.
 */
import { appController, AppController } from '../state/controller';

import { appState, AppState } from '../domain/state';
import { llmManager, LLMManager } from './llm-manager';
import { PromptBuilder } from '../domain/prompt-builder';
import { entityManager, EntityManager } from '../state/entity-manager';
import { DateUtils } from '../utils/date-utils';
import { validateEntity } from '../domain/verifier';
import { BaseEntity } from '../domain/types';

export class ChatHandler {
  constructor(
    private appController: AppController,
    private appState: AppState,
    private llmManager: LLMManager,
    private entityManager: EntityManager
  ) { }

  async handleUserMessage(text: string) {
    // 1. Optimistic UI Update
    this.appController.addChatMessage({ role: 'user', text });

    try {
      const workerSystemPrompt = PromptBuilder.buildWorkerSystemInstruction(this.appState.database);
      const previousHistory = this.appState.database.chat_history.slice(0, -1);
      const fullPrompt = PromptBuilder.buildWorkerUserPrompt(this.appState.database, previousHistory, text);

      let currentPrompt = fullPrompt;
      let turns = 0;
      const MAX_TURNS = 3;

      while (turns < MAX_TURNS) {
        turns++;
        const response = await this.llmManager.generateResponse(currentPrompt, workerSystemPrompt, {
          forceMock: this.appState.local.settings.useMockLLM
        });

        if (response.text) {
          this.appController.addChatMessage({ role: 'assistant', text: response.text });
        }

        if (response.tool_calls && response.tool_calls.length > 0) {
          // Tool execution logic.
          let toolFailed = false;
          for (const tool of response.tool_calls) {
            console.log("Executing Tool:", tool.name, tool.arguments);
            const result = this.executeTool(tool.name, tool.arguments);
            if (!result.success) {
              toolFailed = true;
              this.appController.addChatMessage({ role: 'assistant', text: `[System Error] ${result.message}. Retrying...` });
              currentPrompt += `\n\nAssistant Tool Call: ${tool.name}(${JSON.stringify(tool.arguments)})`;
              currentPrompt += `\nSystem: Tool execution failed. Error: ${result.message}. Please correct your parameters and try again.`;
            }
          }
          if (!toolFailed) break;
        } else {
          break;
        }
      }

    } catch (error) {
      console.error("LLM Error:", error);
      this.appController.addChatMessage({ role: 'assistant', text: "I'm having trouble connecting to the network right now." });
    }
  }

  public executeTool(name: string, args: any): { success: boolean; message?: string } {
    // Dynamic Dispatch for Specific Tools
    let effectiveName = name;
    let effectiveArgs = { ...args };

    if (name.startsWith('upsert') && name !== 'upsertEntity') {
      const type = name.replace('upsert', '');
      effectiveName = 'upsertEntity';
      effectiveArgs.entity_type = type;
    } else if (name.startsWith('patch') && name !== 'patchEntity') {
      const type = name.replace('patch', '');
      effectiveName = 'patchEntity';
      effectiveArgs.entity_type = type;
      if (args.id) effectiveArgs.entity_id = args.id;
    }

    switch (effectiveName) {
      case 'upsertEntity': {
        const cleanArgs = DateUtils.restoreTimestamps(effectiveArgs, new Date());

        // Validate before mutating state
        const validationErrors = validateEntity(cleanArgs.entity, cleanArgs.entity_type, this.appState.database);
        if (validationErrors.length > 0) {
          const errorMsg = validationErrors.map(e => `${e.field}: ${e.message}`).join(', ');
          return { success: false, message: `Validation Failed: ${errorMsg}` };
        }

        const upsertRes = this.entityManager.upsertEntity(cleanArgs);

        if (!upsertRes.success) {
          return { success: false, message: upsertRes.message };
        } else {
          // Fetch updated entity to display
          const { entity_id, log } = upsertRes.data;
          const type = cleanArgs.entity_type;

          const collection = this.entityManager.getCollectionName(type);
          const entity = (this.appState.database as unknown as Record<string, Record<string, BaseEntity> | undefined>)[collection]?.[entity_id];

          if (entity) {
            this.appController.addChatMessage({
              role: 'assistant',
              text: '', // Empty text, using widget
              type: 'entity_update',
              data: { entity, log, entityType: type, mutation: effectiveArgs }
            });
          }
          return { success: true };
        }
      }

      case 'deleteEntity':
        const delRes = this.entityManager.deleteEntity(effectiveArgs);
        if (!delRes.success) {
          return { success: false, message: delRes.message };
        }
        return { success: true };

      case 'patchEntity': {
        // Warning: patchEntity takes 'patches', not a full entity.
        // We need to restore timestamps inside the patches 'value' if applicable.
        const cleanArgs = DateUtils.restoreTimestamps(effectiveArgs, new Date());
        const patchRes = this.entityManager.patchEntity(cleanArgs);

        if (!patchRes.success) {
          console.error(`[ChatHandler] patchEntity failed: ${patchRes.message}`);
          return { success: false, message: patchRes.message };
        } else {
          // Fetch updated entity
          const { entity_id, log } = patchRes.data;
          const type = cleanArgs.entity_type;

          const collection = this.entityManager.getCollectionName(type);
          const entity = (this.appState.database as unknown as Record<string, Record<string, BaseEntity> | undefined>)[collection]?.[entity_id];

          if (entity) {
            this.appController.addChatMessage({
              role: 'assistant',
              text: '',
              type: 'entity_update',
              data: { entity, log, entityType: type, mutation: effectiveArgs }
            });
          }
          return { success: true };
        }
      }

      default:
        console.warn("Unknown tool:", effectiveName);
        return { success: false, message: `Unknown tool: ${effectiveName}` };
    }
  }
}

export const chatHandler = new ChatHandler(appController, appState, llmManager, entityManager);
