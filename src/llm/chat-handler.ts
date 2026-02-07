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
import { validateEntity } from '../domain/verifier';
import { PatchIRRequest, ReplaceIRRequest } from '../state/entity-api';

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
      const workerSystemPrompt = PromptBuilder.buildWorkerSystemInstruction();
      const previousHistory = this.appState.database.chat_history.slice(0, -1);
      const fullPrompt = PromptBuilder.buildWorkerUserPrompt({ database: this.appState.database, ephemeral: this.appState.local }, previousHistory, text);

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
    let effectiveArgs = args;

    switch (effectiveName) {
      case 'replaceIR': {
        const entity_type = 'IR';
        const cleanArgs: ReplaceIRRequest = effectiveArgs;

        // Validate before mutating state.
        // NOTE: This check (via validateEntity) only enforces structural/schema integrity.
        // Logic errors (e.g. invalid node connections) are allowed to be saved and are
        // surfaced later via the Diagnostics UI/context.
        const validationErrors = validateEntity(cleanArgs as any, entity_type, this.appState.database);
        if (validationErrors.length > 0) {
          const errorMsg = validationErrors.map(e => `${e.field}: ${e.message}`).join(', ');
          return { success: false, message: `Validation Failed (Structural): ${errorMsg}` };
        }

        const upsertRes = this.entityManager.replaceIR(cleanArgs);

        if (!upsertRes.success) {
          return { success: false, message: upsertRes.message };
        } else {
          // Fetch updated entity to display
          const log = upsertRes.errors;
          const type = entity_type;
          const entity = this.appState.database.ir;

          this.appController.addChatMessage({
            role: 'assistant',
            text: '', // Empty text, using widget
            type: 'entity_update',
            data: { entity, log, entityType: type, mutation: effectiveArgs }
          });
          return { success: true };
        }
      }

      case 'patchIR': {
        // Warning: patchEntity takes 'patches', not a full entity.
        const entity_type = 'IR';
        const cleanArgs: PatchIRRequest = effectiveArgs;
        const patchRes = this.entityManager.patchIR(cleanArgs);

        if (!patchRes.success) {
          console.error(`[ChatHandler] patchEntity failed: ${patchRes.message}`);
          return { success: false, message: patchRes.message };
        } else {
          // Fetch updated entity
          const log = patchRes.errors;
          const type = entity_type;
          const entity = this.appState.database.ir;

          this.appController.addChatMessage({
            role: 'assistant',
            text: '',
            type: 'entity_update',
            data: { entity, log, entityType: type, mutation: effectiveArgs }
          });
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
