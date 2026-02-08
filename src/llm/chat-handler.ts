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
import { GoogleGenAIManager, LLMManager } from './llm-manager';
import { PromptBuilder } from '../domain/prompt-builder';
import { entityManager, EntityManager } from '../state/entity-manager';
import { IREditResponse, PatchIRRequest, ReplaceIRRequest } from '../state/entity-api';
import { BuiltinOp, OpDefs } from '../ir/builtin-schemas';
import { opDefToFunctionDeclaration } from '../domain/schemas';
import { ALL_EXAMPLES } from '../domain/example-ir';

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
      const previousHistory = this.appState.database.chat_history.slice(0, -1);
      const fullPrompt = PromptBuilder.buildWorkerUserPrompt({ database: this.appState.database, ephemeral: this.appState.local }, previousHistory, text);

      await this.llmManager.generateResponse(fullPrompt, {
        forceMock: this.appState.local.settings.useMockLLM,
        executeTool: async (name, args) => {
          console.log("Executing Tool:", name, args);
          try {
            const result = await this.executeTool(name, args);
            console.log("Done Tool:", name, result);
            return result;
          } catch (e) {
            console.warn("Error Running Tool:", name, e);
            return { end: false, response: e?.toString() ?? 'unknown error' };
          }
        }
      });

    } catch (error) {
      console.error("LLM Error:", error);
      this.appController.addChatMessage({ role: 'assistant', text: "I'm having trouble connecting to the network right now." });
    }
  }

  public async executeTool(name: string, args: any): Promise<{ end: boolean; response: IREditResponse; }> {
    // Dynamic Dispatch for Specific Tools
    const effectiveName = name;
    const effectiveArgs = args;

    switch (effectiveName) {
      case 'final_response': {
        const text = effectiveArgs.text;
        if (text) {
          this.appController.addChatMessage({ role: 'assistant', text });
        }
        return { end: true, response: { success: true, message: 'sent' } };
      }

      case 'replaceIR': {
        const cleanArgs: ReplaceIRRequest = effectiveArgs;
        const upsertRes = await this.entityManager.replaceIR(cleanArgs);

        // TODO: Trigger and wait for result
        // upsertRes.compileResult = undefined;

        this.appController.addChatMessage({
          role: 'tool-response',
          text: '',
          type: 'entity_update',
          data: structuredClone(upsertRes)
        });
        return { end: false, response: upsertRes };
      }

      case 'patchIR': {
        const cleanArgs: PatchIRRequest = effectiveArgs;
        const patchRes = await this.entityManager.patchIR(cleanArgs);

        // TODO: Trigger and wait for result
        // upsertRes.compileResult = undefined;

        this.appController.addChatMessage({
          role: 'tool-response',
          text: '',
          type: 'entity_update',
          data: structuredClone(patchRes)
        });
        return { end: false, response: patchRes };
      }

      case 'queryDocs': {
        const opName = effectiveArgs.op as BuiltinOp | undefined;
        const exampleName = effectiveArgs.example as string | undefined;
        const listType = effectiveArgs.list as 'op' | 'example' | undefined;

        // 1. Handle Example Lookup
        if (exampleName) {
          const example = (ALL_EXAMPLES as any)[exampleName];
          if (!example) {
            return { end: false, response: { success: false, message: `Unknown example: ${exampleName}` } };
          }
          const queryRes: IREditResponse = { success: true, message: `Example IR: ${exampleName}`, docsResult: example };
          this.appController.addChatMessage({
            role: 'tool-response',
            text: `Showing example IR for ${exampleName}`,
            type: 'entity_update',
            data: structuredClone(queryRes)
          });
          return { end: false, response: queryRes };
        }

        // 2. Handle Listing
        if (listType === 'example') {
          const lines = Object.entries(ALL_EXAMPLES).map(([key, ir]) => {
            const metaName = (ir as any).meta?.name || 'Unnamed';
            const comment = (ir as any).comment || '';
            const line = `- **${key}** (${metaName})${comment ? `: ${comment}` : ''}`;
            return line;
          });
          const summary = `Available Example IRs:\n\n${lines.join('\n')}`;
          const queryRes: IREditResponse = { success: true, message: summary };
          this.appController.addChatMessage({
            role: 'tool-response',
            text: summary,
            type: 'text',
            data: structuredClone(queryRes)
          });
          return { end: false, response: queryRes };
        }

        if (listType === 'op' || (!opName && !exampleName && !listType)) {
          // List all operations (default if nothing else provided)
          const lines = Object.entries(OpDefs).map(([name, def]) => `- **${name}**: ${def.doc}`);
          const summary = `Available IR Operations:\n\n${lines.join('\n')}`;

          const queryRes: IREditResponse = { success: true, message: summary };
          this.appController.addChatMessage({
            role: 'tool-response',
            text: summary,
            type: 'text',
            data: structuredClone(queryRes)
          });
          return { end: false, response: queryRes };
        }

        // 3. Handle Op Lookup (existing behavior)
        if (opName) {
          const def = OpDefs[opName];
          if (!def) {
            return { end: false, response: { success: false, message: `Unknown operation: ${opName}` } };
          }

          const doc = opDefToFunctionDeclaration(opName, def);
          const queryRes: IREditResponse = { success: true, message: `Documentation for ${opName}`, docsResult: doc };
          this.appController.addChatMessage({
            role: 'tool-response',
            text: `Showing docs for ${opName}`,
            type: 'entity_update',
            data: structuredClone(queryRes)
          });
          return { end: false, response: queryRes };
        }

        return { end: false, response: { success: false, message: 'Invalid queryDocs arguments' } };
      }

      default:
        console.warn("Unknown tool:", effectiveName);
        return { end: false, response: { success: false, message: `Unknown tool: ${effectiveName}` } };
    }
  }
}

export const chatHandler = new ChatHandler(
  appController,
  appState,
  new GoogleGenAIManager(appController, PromptBuilder.buildWorkerSystemInstruction()),
  entityManager
);
