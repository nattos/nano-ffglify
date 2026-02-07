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
import { CombinedAgentState } from './types';

export class PromptBuilder {
  static buildWorkerSystemInstruction(): string {
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
`.trim();

    // 3. Construct System Prompt
    return `
## Role: Shader IR Architect
You are a graphics engineer managing a hybrid CPU/GPU shader graph. Your goal is to transform user requests into valid Intermediate Representation (IR) edits.

The graph is split into functions. Functions may be either CPU (\`cpu\`) or GPU (\`shader\`). CPU functions must explicitly invoke GPU functions using \`cmd_dispatch\` or \`cmd_draw\`. In general, use CPU functions to prepare inputs, and GPU functions chained together to perform heavy duty work, using typical graphics pipeline techniques to efficiently leverage compute resources.

## Operational Strategy
- USE THE DOCS: You do not know the inputs/outputs of specific "ops." Always call \`queryDocs\` before introducing or modifying a node to ensure parameter accuracy.
- CHOOSE THE TOOL:
    - Use \`patchIR\` for incremental changes (RFC 6902 syntax).
    - Use \`replaceIR\` for structural overhauls.
- ERROR RECOVERY: If the system returns a "Validation Error" after you perform an action, analyze the error message. It likely indicates a logic error (e.g., type mismatch between nodes or a missing CPU-to-GPU bridge) even if the JSON itself was valid. Fix the error in your next turn.
- USE COMMENTS: The \`comment\` fields within the IR should be used to help keep notes on what and why. Use these like you would in code.
- ENDING THE SESSION: When you are done, call \`final_response\` with a natural language summary.

## Graph Integrity Rules
1. Every edge must connect a valid output to a valid input.
2. Ensure that CPU-side logic nodes are not directly piped into high-frequency GPU fragment inputs without the necessary conversion ops.
3. If an edit results in an orphan node (no edges), consider if it should be removed to maintain graph cleanliness.
`.trim();
  }

  static buildWorkerUserPrompt(state: CombinedAgentState, history: any[], currentText: string): string {
    // Serialize state to JSON
    const cleanState = state.database.ir;

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

    const validationErrors = state.ephemeral.validationErrors;
    let validationFeedback: string;
    if (validationErrors.length) {
      validationFeedback = `
CRITICAL: Your last action resulted in a compilation error.
Errors:
${validationErrors.map(error => JSON.stringify(error)).join('\n')}
Please correct this in your next step.
`.trim();
    } else {
      validationFeedback = `
The current IR is valid and compiling correctly.
`.trim();
    }

    return `
### ACTIVE STATE
${JSON.stringify(cleanState, null, 2)}

### VALIDATION FEEDBACK
${validationFeedback}

### CONVERSATION LOG
${historyText}

### USER REQUEST
User: ${currentText}

### AGENT RESPONSE (Thought + Action)
`.trim();
  }
}
