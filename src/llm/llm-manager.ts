/**
 * @file llm-manager.ts
 * @description Wrapper around the Google Gemini SDK.
 * Handles API configuration, tool registration (from Schemas), and Mock Mode.
 *
 * @external-interactions
 * - Connects to `https://generativelanguage.googleapis.com`.
 * - Injects `AppController` to log prompts/responses for the debug UI.
 *
 * @pitfalls
 * - Requires valid `GOOGLE_API_KEY`.
 * - Mock matching logic is fuzzy regex; collisions happen if mock prompts are too similar.
 */
import { GoogleGenerativeAI, SchemaType, FunctionDeclaration, GenerativeModel, FunctionResponsePart, FunctionResponse } from "@google/generative-ai";

import { AppController } from '../state/controller';
import { generatePatchTool, generateReplaceTool } from '../domain/schemas';
import { NOTES_MOCKS } from '../domain/mock-responses';
import { IRSchema } from "../domain/types";
import { DEFAULT_LLM_MODEL } from "../constants";
import { OpSignatures } from "../ir/signatures";

export interface LLMToolCall {
  name: string;
  arguments: any;
}

export interface LLMResponse {
  text?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMOptions {
  forceMock?: boolean;
  maxTurns?: number;
  executeTool?: (name: string, args: any) => Promise<{ end: boolean; response: any; }>;
}

export interface LLMManager {
  generateResponse(prompt: string, options?: LLMOptions): Promise<LLMResponse>;
}

interface ChatSessionAdapter {
  sendMessage(input: string | FunctionResponsePart[]): Promise<LLMResponse>;
}

export class GoogleGenAIManager implements LLMManager {
  private apiKey = import.meta.env.GOOGLE_API_KEY || "";
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor(private appController: AppController, private systemInstruction: string) {
    if (!this.apiKey) {
      console.warn("No GOOGLE_API_KEY provided. LLM will not function correctly.");
    }

    // Load default mocks
    Object.entries(NOTES_MOCKS).forEach(([key, val]) => {
      this.mockRegistry.set(key.toLowerCase(), Array.isArray(val) ? val : [val]);
    });

    // Generate Native Tools from Schemas
    const tools: FunctionDeclaration[] = [];

    // 1. Core Tools
    tools.push({
      name: "final_response",
      description: "Send the final text response to the user. Always use this to end the turn.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: { text: { type: SchemaType.STRING, description: "The response text." } },
        required: ["text"]
      }
    });

    // 2. Schema-Driven Tools
    tools.push(generateReplaceTool(IRSchema));
    tools.push(generatePatchTool(IRSchema));

    // 3. Documentation Tools
    tools.push({
      name: "queryDocs",
      description: "Look up the schema and documentation for a specific IR operation (op). Returns a JSON object describing the parameters.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          op: {
            type: SchemaType.STRING,
            format: 'enum',
            enum: Object.keys(OpSignatures),
            description: "The name of the operation to look up (e.g., 'math_add', 'texture_sample').",
          }
        },
        required: ["op"]
      }
    });
    console.log(tools);

    this.genAI = new GoogleGenerativeAI(this.apiKey);
    this.model = this.genAI.getGenerativeModel({
      model: DEFAULT_LLM_MODEL,
      systemInstruction: systemInstruction,
      // Define tools for the model
      tools: [{
        functionDeclarations: tools
      }]
    });
  }

  // Registry for deterministic testing - support multi-step responses
  private mockRegistry: Map<string, LLMResponse[]> = new Map();

  public setMockRegistry(registry: Record<string, LLMResponse | LLMResponse[]>) {
    this.mockRegistry.clear();
    Object.entries(registry).forEach(([key, val]) => {
      this.mockRegistry.set(key.toLowerCase(), Array.isArray(val) ? val : [val]);
    });
  }

  async generateResponse(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const start = Date.now();
    const sessionId = crypto.randomUUID();
    let finalResponse: LLMResponse = { text: "" };
    const mocked = !!options?.forceMock;
    const maxTurns = options?.maxTurns || 5;
    let turns = 0;

    // 1. Setup Session Adapter
    let session: ChatSessionAdapter;

    if (mocked) {
      const lowerPrompt = prompt.toLowerCase();
      const lines = lowerPrompt.split('\n');
      let registryMatch: LLMResponse[] | undefined;
      let maxLineIndex = -1;

      for (const [key, val] of this.mockRegistry.entries()) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedKey}\\b`, 'i');
        let foundIndex = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (regex.test(lines[i])) {
            foundIndex = i;
            break;
          }
        }
        if (foundIndex > -1 && foundIndex > maxLineIndex) {
          maxLineIndex = foundIndex;
          registryMatch = val;
        }
      }

      const match = registryMatch;
      session = {
        async sendMessage(_input: string | FunctionResponsePart[]) {
          if (!match || turns > match.length) {
            return { text: "[MOCK] No more mock steps or no match found." };
          }
          return match[turns - 1]; // turns is incremented before sendMessage is called
        }
      };
    } else {
      console.log("Starting Chat with Gemini...");
      const realChat = this.model.startChat({});
      session = {
        async sendMessage(input: string | FunctionResponsePart[]) {
          const result = await realChat.sendMessage(input);
          const apiResponse = result.response;
          const text = apiResponse.text();
          const toolCalls: LLMToolCall[] = [];
          const calls = apiResponse.functionCalls();
          if (calls && calls.length > 0) {
            calls.forEach((c: any) => {
              toolCalls.push({ name: c.name, arguments: c.args });
            });
          }
          return { text: text || undefined, tool_calls: toolCalls.length > 0 ? toolCalls : undefined };
        }
      };
    }

    // 2. Unified Multi-Turn Loop
    let currentInput: string | FunctionResponsePart[] = prompt;

    try {
      while (turns < maxTurns) {
        turns++;
        const turnStart = Date.now();

        const response = await session.sendMessage(currentInput);
        finalResponse = response;

        // Log this turn
        this.appController.logLLMInteraction({
          id: sessionId,
          timestamp: Date.now(),
          turn_index: turns,
          type: 'chat',
          system_instruction_snapshot: this.systemInstruction,
          prompt_snapshot: typeof currentInput === 'string' ? currentInput : JSON.stringify(currentInput),
          response_snapshot: JSON.stringify(response),
          duration_ms: mocked ? 0 : Date.now() - turnStart,
          mocked
        });

        let toolCalls: LLMToolCall[];
        if (response.tool_calls && response.tool_calls.length) {
          toolCalls = response.tool_calls;
        } else {
          // No tool calls. If we have text, call final_response as fallback
          toolCalls = [{ name: 'final_response', arguments: { text: response.text } }];
        }
        let sessionEnded = false;
        if (!options?.executeTool) {
          sessionEnded = true;
        } else {
          const functionResponses: FunctionResponsePart[] = [];

          for (const call of toolCalls) {
            const toolResult = await options.executeTool(call.name, call.arguments);
            this.appController.logLLMInteraction({
              id: sessionId,
              timestamp: Date.now(),
              turn_index: turns,
              type: 'tool_call',
              prompt_snapshot: JSON.stringify(call),
              response_snapshot: JSON.stringify(toolResult),
              duration_ms: mocked ? 0 : Date.now() - turnStart,
              mocked
            });
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: toolResult.response
              }
            });

            if (toolResult.end || call.name === 'final_response') {
              sessionEnded = true;
            }
          }
          currentInput = functionResponses;
        }

        if (sessionEnded) {
          break;
        }
      }
    } catch (error) {
      console.error("LLM Session Error:", error);
      finalResponse = { text: "Error during conversation." };
      this.appController.logLLMInteraction({
        id: sessionId,
        timestamp: Date.now(),
        turn_index: turns,
        type: 'error',
        system_instruction_snapshot: this.systemInstruction,
        prompt_snapshot: prompt,
        response_snapshot: error?.toString() ?? 'Unknown',
        duration_ms: Date.now() - start,
        mocked
      });
    }

    return finalResponse;
  }
}
