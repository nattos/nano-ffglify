/**
 * @file prompt-builder.ts
 * @description Constructs the System Persona and Request Context for the LLM.
 * This is a "Blueprint" file where the "Personality" of the app is defined.
 *
 * @external-interactions
 * - Called by `chat-handler.ts` before every LLM turn.
 * - Reads `DatabaseState` to serialize the current context.
 *
 * @pitfalls
 * - The `EXAMPLES` string is critical for teaching the LLM how to use tools. If tools change, examples MUST be updated.
 * - Context window size is finite; sending the *entire* database in `buildContext` will eventually hit limits. Pagination or RAG needed for large apps.
 */
import { DatabaseState } from './types';

import { DateUtils } from '../utils/date-utils';

export class PromptBuilder {
  static buildWorkerSystemInstruction(state: DatabaseState): string {
    // Define Few-Shot Examples
    const EXAMPLES = `
EXAMPLES:
1. User: "Create a simple triangle shader."
   Assistant Tool Call: {
     "name": "upsertIR",
     "arguments": {
       "entity": {
         "meta": { "name": "Triangle" },
         "functions": [
           { "id": "main", "type": "shader", "nodes": [...] }
         ]
       }
     }
   }

2. User: "Update the kernel size to 32."
   Assistant Tool Call: {
     "name": "patchIR",
     "arguments": {
       "id": "current-ir",
       "patches": [{ "op": "replace", "path": "/inputs/1/default", "value": "32" }]
     }
   }
`;

    // 3. Construct System Prompt
    return `You are the WebGPU IR Assistant.
      Current Date: ${new Date().toISOString().split('T')[0]}

${EXAMPLES}

    INSTRUCTIONS:
1. Analyze the user's request and the current IR state.
2. Use 'upsertIR' to create or update the shader graph.
3. Use 'patchIR' for small updates like changing defaults or adding nodes/properties.
   - Use JSON Patch format(op: "replace", "add", "remove").
4. When you are done, call 'final_response' with a natural language summary.
`;
  }

  static buildWorkerUserPrompt(state: DatabaseState, history: any[], currentText: string): string {
    return `${this.buildContext(state, history)}\n\nUser: ${currentText}`;
  }
  static buildContext(state: DatabaseState, history: any[] = []): string {
    const today = new Date().toISOString().split('T')[0];

    // Serialize state to JSON
    const cleanState = {
      ir: state.ir
    };

    // Format History
    const historyText = history.slice(-10).map(m => {
      if (m.type === 'entity_update') {
        const { entityType, entity } = m.data || {};
        const label = entity?.meta?.name || entity?.id || 'Unknown';
        return `[SYSTEM UPDATE] ${entityType} '${label}'... (${entity?.id}) was modified.`;
      }
      const role = m.role.charAt(0).toUpperCase() + m.role.slice(1);
      return `${role}: ${m.text || '(Action)'} `;
    }).join('\n');

    return `
    CONTEXT(Full State JSON):
    - Today: ${today}
    - State:
${JSON.stringify(cleanState, null, 2)}

RECENT HISTORY:
${historyText || '(No history)'}
    `;
  }
}
