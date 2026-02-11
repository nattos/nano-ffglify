import { describe, it, expect } from 'vitest';
import { NOTES_MOCKS, NOTES_MOCKS2 } from '../src/domain/mock-responses';
import { validateEntity } from '../src/domain/verifier';
import { DateUtils } from '../src/utils/date-utils';


describe('Mock Response Validation', () => {
  const allMocks = { ...NOTES_MOCKS, ...NOTES_MOCKS2 };
  Object.entries(allMocks).forEach(([key, response]) => {
    const responses = Array.isArray(response) ? response : [response];

    responses.forEach((resp, rIdx) => {
      if (!resp.tool_calls || resp.tool_calls.length === 0) return;

      describe(`Mock: "${key}"${Array.isArray(response) ? ` [${rIdx}]` : ''}`, () => {
        resp.tool_calls.forEach((tool, idx) => {
          it(`Tool Call ${idx + 1}: ${tool.name}`, () => {
            if (tool.name.startsWith('upsert') || tool.name === 'replaceIR') {
              const args = tool.arguments;
              // 1. Simulate ChatHandler timestamp restoration
              const cleanArgs = DateUtils.restoreTimestamps(args, new Date());

              // Determine type
              let type = cleanArgs.entity_type;
              if (!type && (tool.name === 'replaceIR' || tool.name === 'upsertIR')) {
                type = 'IR';
              } else if (!type && tool.name !== 'upsertEntity') {
                type = tool.name.replace('upsert', '');
              }

              // 2. Mock State for validation context
              const mockState: any = {
                notes: {},
                chat_history: []
              };

              // 3. Validate Entity
              const errors = validateEntity(cleanArgs.entity || cleanArgs, type, mockState);

              // Filter out Reference errors (because mockState is empty)
              const structuralErrors = errors.filter(e => !e.message.includes('Ref') && !e.message.includes('exist'));

              if (structuralErrors.length > 0) {
                const msg = structuralErrors.map(e => `${e.field}: ${e.message}`).join(', ');
                throw new Error(`Validation Failed for ${key} [${tool.name}]: ${msg}`);
              }
            }
          });
        });
      });
    });
  });
});
