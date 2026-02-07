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
import { GoogleGenerativeAI, SchemaType, FunctionDeclaration } from "@google/generative-ai";

import { appController, AppController } from '../state/controller';
import { generatePatchTool, generateReplaceTool } from '../domain/schemas';
import { NOTES_MOCKS } from '../domain/mock-responses';
import { ALL_SCHEMAS, IRSchema } from "../domain/types";
import { DEFAULT_LLM_MODEL } from "../constants";

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
  generateResponse(prompt: string, systemInstruction?: string, options?: LLMOptions): Promise<LLMResponse>;
}

export class GoogleGenAIManager implements LLMManager {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor(private apiKey: string, private appController: AppController) {
    if (!apiKey) {
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
          op: { type: SchemaType.STRING, description: "The name of the operation to look up (e.g., 'math_add', 'texture_sample')." }
        },
        required: ["op"]
      }
    });
    console.log(tools);

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({
      model: DEFAULT_LLM_MODEL,
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

  async generateResponse(prompt: string, systemInstruction?: string, options?: LLMOptions): Promise<LLMResponse> {
    const start = Date.now();
    let finalResponse: LLMResponse = { text: "" };
    let mocked = false;

    const maxTurns = options?.maxTurns || 5;
    let turns = 0;

    // Check Mock Mode from Options (Caller must provide preference)
    if (options?.forceMock) {
      mocked = true;
      const lowerPrompt = prompt.toLowerCase();

      // Simple mock lookup based on initial prompt
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

      if (registryMatch) {
        // Multi-turn mock simulation
        for (const step of registryMatch) {
          turns++;
          if (turns > maxTurns) break;

          finalResponse = step;

          if (step.tool_calls && options?.executeTool) {
            let shouldEnd = false;
            for (const call of step.tool_calls) {
              const res = await options.executeTool(call.name, call.arguments);
              if (res.end) shouldEnd = true;
            }
            if (shouldEnd) break;
          } else {
            // No tool calls (or finished), but if there's text, we should show it
            if (step.text && options?.executeTool) {
              await options.executeTool('final_response', { text: step.text });
            }
            break;
          }
        }
      } else {
        finalResponse = { text: "[MOCK] No matching mock response found." };
        // If we expect tool calls but failed, try calling final_response as fallback
        if (options?.executeTool) {
          await options.executeTool('final_response', { text: finalResponse.text });
        }
      }

    } else {
      // Real API Call Logic.
      try {
        console.log("Starting Chat with Gemini...");
        const chat = this.model.startChat({
          history: systemInstruction ? [
            { role: "user", parts: [{ text: systemInstruction }] },
            { role: "model", parts: [{ text: "Understood. I am the WebGPU IR Assistant." }] }
          ] : []
        });

        let currentInput: string | any = prompt;

        while (turns < maxTurns) {
          turns++;
          const result = await chat.sendMessage(currentInput);
          const apiResponse = result.response;
          const text = apiResponse.text();

          const toolCalls: LLMToolCall[] = [];
          const calls = apiResponse.functionCalls();
          if (calls && calls.length > 0) {
            calls.forEach((c: any) => {
              toolCalls.push({ name: c.name, arguments: c.args });
            });
          }

          finalResponse = { text: text || undefined, tool_calls: toolCalls.length > 0 ? toolCalls : undefined };

          if (toolCalls.length > 0 && options?.executeTool) {
            const functionResponses = [];
            let sessionEnded = false;

            for (const call of toolCalls) {
              const toolResult = await options.executeTool(call.name, call.arguments);

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

            if (sessionEnded) {
              break;
            }

            // Feed tool results back to chat
            currentInput = functionResponses;
          } else {
            // No tool calls. If we have text, call final_response as fallback
            if (text && options?.executeTool) {
              await options.executeTool('final_response', { text });
            }
            break;
          }
        }

      } catch (error) {
        console.error("Gemini API Error:", error);
        finalResponse = { text: "Error connecting to AI." };
      }
    }

    // Log Interaction via injected controller
    this.appController.logLLMInteraction({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      system_instruction_snapshot: systemInstruction,
      prompt_snapshot: prompt,
      response_snapshot: JSON.stringify(finalResponse),
      duration_ms: Date.now() - start,
      mocked
    });

    return finalResponse;
  }
}

const apiKey = import.meta.env.GOOGLE_API_KEY || "TEST_KEY";
export const llmManager = new GoogleGenAIManager(apiKey, appController);
