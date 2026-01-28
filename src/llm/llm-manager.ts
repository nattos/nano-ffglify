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
import { generateUpsertTool, generatePatchTool } from '../domain/schemas';
import { NOTES_MOCKS } from '../domain/mock-responses';
import { ALL_SCHEMAS } from "../domain/types";
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
    Object.entries(NOTES_MOCKS).forEach(([key, val]) => this.mockRegistry.set(key.toLowerCase(), val));

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


    tools.push({
      name: "deleteEntity",
      description: "Soft delete an entity.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          entity_type: { type: SchemaType.STRING, enum: ["Note"], format: "enum" as any },
          entity_id: { type: SchemaType.STRING }
        },
        required: ["entity_type", "entity_id"]
      }
    });

    // 2. Schema-Driven Tools
    Object.values(ALL_SCHEMAS).forEach(schema => {
      tools.push(generateUpsertTool(schema));
      tools.push(generatePatchTool(schema));
    });

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({
      model: DEFAULT_LLM_MODEL,
      // Define tools for the model
      tools: [{
        functionDeclarations: tools
      }]
    });
  }

  // Registry for deterministic testing
  private mockRegistry: Map<string, LLMResponse> = new Map();

  public setMockRegistry(registry: Record<string, LLMResponse>) {
    this.mockRegistry.clear();
    Object.entries(registry).forEach(([key, val]) => this.mockRegistry.set(key.toLowerCase(), val));
  }

  async generateResponse(prompt: string, systemInstruction?: string, options?: LLMOptions): Promise<LLMResponse> {
    const start = Date.now();
    let response: LLMResponse;
    let mocked = false;

    // Check Mock Mode from Options (Caller must provide preference)
    if (options?.forceMock) {
      mocked = true;
      const lowerPrompt = prompt.toLowerCase();

      // Simple mock lookup
      const candidates: Map<string, LLMResponse> = new Map();
      for (const [key, val] of this.mockRegistry.entries()) candidates.set(key, val);

      const lines = lowerPrompt.split('\n');
      let registryMatch: LLMResponse | undefined;
      let maxLineIndex = -1;

      for (const [key, val] of candidates.entries()) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedKey}\\b`, 'i');

        // Find match on latest line
        let foundIndex = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (regex.test(lines[i])) {
            foundIndex = i;
            break;
          }
        }

        if (foundIndex > -1) {
          if (foundIndex > maxLineIndex) {
            maxLineIndex = foundIndex;
            registryMatch = val;
          } else if (foundIndex === maxLineIndex) {
            // Tie-breaker: existing registry order priority
            registryMatch = val;
          }
        }
      }

      if (registryMatch) {
        response = registryMatch;
      } else {
        response = { text: "[MOCK] No matching mock response found." };
      }

    } else {
      // Real API Call Logic.
      try {
        console.log("Calling Gemini with:", { prompt });
        const chat = this.model.startChat({
          history: systemInstruction ? [
            { role: "user", parts: [{ text: systemInstruction }] },
            { role: "model", parts: [{ text: "Understood. I am Brunch & Bloom, your culinary assistant." }] }
          ] : []
        });

        const result = await chat.sendMessage(prompt);
        const apiResponse = result.response;
        const text = apiResponse.text();

        const toolCalls: LLMToolCall[] = [];
        const call = apiResponse.functionCalls();
        if (call && call.length > 0) {
          call.forEach((c: any) => {
            toolCalls.push({ name: c.name, arguments: c.args });
          });
        }

        response = { text, tool_calls: toolCalls.length > 0 ? toolCalls : undefined };

      } catch (error) {
        console.error("Gemini API Error:", error);
        response = { text: "Error connecting to AI." };
      }
    }

    // Log Interaction via injected controller
    this.appController.logLLMInteraction({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      prompt_snapshot: prompt,
      response_snapshot: JSON.stringify(response),
      duration_ms: Date.now() - start,
      mocked
    });

    return response;
  }
}

const apiKey = import.meta.env.GOOGLE_API_KEY || "TEST_KEY";
export const llmManager = new GoogleGenAIManager(apiKey, appController);
