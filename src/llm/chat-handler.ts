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
import { BuiltinOp, OpDef, OpDefs } from '../ir/builtin-schemas';
import { FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { opDefToFunctionDeclaration } from '../domain/schemas';

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

      await this.llmManager.generateResponse(fullPrompt, workerSystemPrompt, {
        forceMock: this.appState.local.settings.useMockLLM,
        executeTool: async (name, args) => {
          console.log("Executing Tool:", name, args);
          const result = this.executeTool(name, args);
          return {
            end: !result.success, // End loop on failure if needed, or based on tool logic
            response: result.success ? (result.data || { success: true }) : { success: false, message: result.message }
          };
        }
      });

    } catch (error) {
      console.error("LLM Error:", error);
      this.appController.addChatMessage({ role: 'assistant', text: "I'm having trouble connecting to the network right now." });
    }
  }

  public executeTool(name: string, args: any): { success: boolean; message?: string; data?: any } {
    // Dynamic Dispatch for Specific Tools
    const effectiveName = name;
    const effectiveArgs = args;

    switch (effectiveName) {
      case 'final_response': {
        const text = effectiveArgs.text;
        if (text) {
          this.appController.addChatMessage({ role: 'assistant', text });
        }
        return { success: true, data: { status: 'sent' } };
      }

      case 'replaceIR': {
        const entity_type = 'IR';
        const cleanArgs: ReplaceIRRequest = effectiveArgs;

        // Validate before mutating state.
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
          return { success: true, data: { status: 'replaced' } };
        }
      }

      case 'patchIR': {
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
          return { success: true, data: { status: 'patched' } };
        }
      }

      case 'queryDocs': {
        const opName = effectiveArgs.op as BuiltinOp;
        const def = OpDefs[opName];

        if (!def) {
          return { success: false, message: `Unknown operation: ${opName}` };
        }

        const doc = opDefToFunctionDeclaration(opName, def);
        const text = `Documentation for \`${opName}\`:\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\``;
        this.appController.addChatMessage({
          role: 'assistant',
          text
        });

        return { success: true, data: doc };
      }

      default:
        console.warn("Unknown tool:", effectiveName);
        return { success: false, message: `Unknown tool: ${effectiveName}` };
    }
  }
}

export const chatHandler = new ChatHandler(appController, appState, llmManager, entityManager);
