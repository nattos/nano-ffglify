import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { SIDECHANNEL_CARDS_SHADER } from '../../domain/example-ir';

const backends = cpuBackends;

describe('Conformance: Integration - Sidechannel Cards', () => {
  if (backends.length === 0) {
    it.skip('Skipping tests (no compatible backend)', () => { });
    return;
  }

  const ir = SIDECHANNEL_CARDS_SHADER;

  backends.forEach(backend => {
    it(`should execute sidechannel cards pipeline [${backend.name}]`, async () => {
      // No sidechannel textures provided — they sample as transparent black.
      // Background texture (in_bg) is also unset, so output will be black.
      // This test primarily verifies the IR compiles and executes without errors.
      const inputs = new Map<string, RuntimeValue>();

      const builtins = new Map<string, RuntimeValue>();
      builtins.set('time', 1.0);
      builtins.set('delta_time', 0.016);

      const context = await backend.execute(ir, 'fn_main_cpu', inputs, builtins);

      // Verify the output texture exists and has data
      const output = context.getResource('output_tex');
      expect(output.data).toBeDefined();
    }, 60000);
  });
});
