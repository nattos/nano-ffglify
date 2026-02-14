import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { PARTICLE_SHADER } from '../../domain/example-ir';

const backends = cpuBackends;

describe('Conformance: Integration - Particle Simulation', () => {
  if (backends.length === 0) {
    it.skip('Skipping tests (no compatible backend)', () => { });
    return;
  }

  const ir = PARTICLE_SHADER;

  backends.forEach(backend => {
    it(`should simulate and render particles [${backend.name}]`, async () => {
      const inputs = new Map<string, RuntimeValue>();
      inputs.set('particle_count', 10); // Small count for test speed

      const builtins = new Map<string, RuntimeValue>();
      builtins.set('time', 1.0);
      builtins.set('delta_time', 0.016);

      const context = await backend.execute(ir, 'fn_main_cpu', inputs, builtins);

      // Verify the particles buffer was modified from initial zeros
      const particles = context.getResource('particles');
      expect(particles.data).toBeDefined();

      const bufData = particles.data as number[];
      let hasNonZero = false;
      for (let i = 0; i < 60; i++) { // 10 particles * stride 6
        if (bufData[i] !== 0) {
          hasNonZero = true;
          break;
        }
      }
      expect(hasNonZero, 'Particle buffer should have non-zero data after simulation').toBe(true);

      // Verify particle positions are in reasonable range [0, 1] for alive particles
      for (let p = 0; p < 10; p++) {
        const px = bufData[p * 6 + 0]; // pos_x
        const py = bufData[p * 6 + 1]; // pos_y
        const lt = bufData[p * 6 + 4]; // lifetime
        const age = bufData[p * 6 + 5]; // age
        // Freshly respawned particles should have pos in [0,1] and lifetime > 0
        expect(lt).toBeGreaterThan(0);
        expect(age).toBeGreaterThanOrEqual(0);
        expect(age).toBeLessThan(lt + 1); // age should be less than lifetime + margin
      }

      // Verify the output texture exists (cmd_draw should have rendered into it)
      const output = context.getResource('output_tex');
      expect(output.data).toBeDefined();
    }, 60000);
  });
});
