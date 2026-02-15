/**
 * @file chat-handler.ts
 * @description The "Brain" of the application. Manages the conversation loop:
 * User Input -> Prompt Building -> LLM API -> Response Parsing -> Tool Execution -> State Mutation.
 */
import { appController, AppController } from '../state/controller';
import { appState, AppState } from '../domain/state';
import { GoogleGenAIManager, LLMManager, llmManager } from './llm-manager';
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
    this.appController.setLLMBusy(true);

    try {
      const previousHistory = this.appState.database.chat_history.slice(0, -1);
      const fullPrompt = PromptBuilder.buildWorkerUserPrompt({ database: this.appState.database, ephemeral: this.appState.local }, previousHistory, text);

      const result = await this.llmManager.generateResponse(fullPrompt, {
        forceMock: this.appState.local.settings.useMockLLM,
        maxTurns: this.appState.local.settings.maxLLMTurns || 25,
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

      if (result.endReason) {
        this.appController.addChatMessage({ role: 'assistant', text: result.endReason });
      }

    } catch (error) {
      console.error("LLM Error:", error);
      this.appController.addChatMessage({ role: 'assistant', text: "I'm having trouble connecting to the network right now." });
    } finally {
      this.appController.setLLMBusy(false);
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

        // Build summary for UI
        const funcs = cleanArgs.functions || [];
        const totalNodes = funcs.reduce((n, f) => n + (f.nodes?.length || 0), 0);
        const funcNames = funcs.map(f => f.id).join(', ');
        const statusIcon = upsertRes.success ? '\u2713' : '\u2717';

        this.appController.addChatMessage({
          role: 'tool-response',
          text: `${statusIcon} replaceIR \u2014 ${funcs.length} function${funcs.length !== 1 ? 's' : ''} (${funcNames}), ${totalNodes} node${totalNodes !== 1 ? 's' : ''}${upsertRes.compileResult ? `, compile: ${upsertRes.compileResult.compileStatus}` : ''}`,
          type: 'entity_update',
          data: structuredClone(upsertRes)
        });
        return { end: false, response: upsertRes };
      }

      case 'patchIR': {
        const cleanArgs: PatchIRRequest = effectiveArgs;
        const patchRes = await this.entityManager.patchIR(cleanArgs);

        const patchCount = cleanArgs.patches?.length || 0;
        const statusIcon = patchRes.success ? '\u2713' : '\u2717';

        this.appController.addChatMessage({
          role: 'tool-response',
          text: `${statusIcon} patchIR \u2014 ${patchCount} edit${patchCount !== 1 ? 's' : ''}${patchRes.compileResult ? `, compile: ${patchRes.compileResult.compileStatus}` : ''}`,
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
            text: `queryDocs \u2014 example: ${exampleName}`,
            type: 'entity_update',
            data: structuredClone(queryRes)
          });
          return { end: false, response: queryRes };
        }

        // 2. Handle Listing
        if (listType === 'example') {
          const count = Object.keys(ALL_EXAMPLES).length;
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
            text: `queryDocs \u2014 listed ${count} examples`,
            type: 'text',
            data: structuredClone(queryRes)
          });
          return { end: false, response: queryRes };
        }

        if (listType === 'op' || (!opName && !exampleName && !listType)) {
          const count = Object.keys(OpDefs).length;
          const lines = Object.entries(OpDefs).map(([name, def]) => `- **${name}**: ${def.doc}`);
          const summary = `Available IR Operations:\n\n${lines.join('\n')}`;

          const queryRes: IREditResponse = { success: true, message: summary };
          this.appController.addChatMessage({
            role: 'tool-response',
            text: `queryDocs \u2014 listed ${count} operations`,
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
            text: `queryDocs \u2014 op: ${opName}`,
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
  llmManager,
  entityManager
);
