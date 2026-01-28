
import { describe, it, expect } from 'vitest';
import { NOTES_MOCKS } from '../src/domain/mock-responses';
import { validateEntity } from '../src/domain/verifier';
import { DateUtils } from '../src/utils/date-utils';


describe('Mock Response Validation', () => {
  Object.entries(NOTES_MOCKS).forEach(([key, response]) => {
    if (!response.tool_calls || response.tool_calls.length === 0) return;

    describe(`Mock: "${key}"`, () => {
      response.tool_calls.forEach((tool, idx) => {
        it(`Tool Call ${idx + 1}: ${tool.name}`, () => {
          if (tool.name.startsWith('upsert')) {
            const args = tool.arguments;
            // 1. Simulate ChatHandler timestamp restoration
            const cleanArgs = DateUtils.restoreTimestamps(args, new Date());

            // Determine type
            let type = cleanArgs.entity_type;
            if (!type && tool.name !== 'upsertEntity') {
              type = tool.name.replace('upsert', '');
            }

            // 2. Mock State for validation context
            const mockState: any = {
              notes: {},
              chat_history: []
            };

            // 3. Validate Entity
            const errors = validateEntity(cleanArgs.entity, type, mockState);

            // Filter out Reference errors (because mockState is empty)
            const structuralErrors = errors.filter(e => !e.message.includes('Ref') && !e.message.includes('exist'));

            if (structuralErrors.length > 0) {
              const msg = structuralErrors.map(e => `${e.field}: ${e.message}`).join(', ');
              throw new Error(`Validation Failed for ${key} [${tool.name}]: ${msg}`);
            }
          }
          // patchEntity doesn't trigger validateEntity in ChatHandler, so we skip it here to match runtime behavior.
          // Or we could try to validate it partially, but Verifier expects full entity.
        });
      });
    });
  });
});
