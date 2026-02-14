import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { PARTICLE_SHADER } from '../../domain/example-ir';

const backends = cpuBackends;

// Helper to extract particle fields from buffer data.
// Three data representations:
// 1. Struct objects (CPU JIT no-GPU): {pos: [x,y], vel: [x,y], lifetime, age}
// 2. Arrays of 6 floats (GPU readback): [x, y, vx, vy, lifetime, age]
// 3. Flat floats (CppMetal): stride 6 at data[index*6+offset]
function getParticle(data: any[], index: number): { lt: number; age: number } {
  const elem = data[index];
  if (Array.isArray(elem)) {
    // Array of 6 floats (GPU readback with componentCount=6)
    return { lt: elem[4], age: elem[5] };
  }
  if (typeof elem === 'object' && elem !== null) {
    // Struct object (CPU JIT)
    return { lt: elem.lifetime, age: elem.age };
  }
  // Flat float layout (CppMetal): stride 6 = pos(2) + vel(2) + lifetime(1) + age(1)
  return { lt: data[index * 6 + 4], age: data[index * 6 + 5] };
}

function hasNonZeroData(data: any[], count: number): boolean {
  for (let i = 0; i < count && i < data.length; i++) {
    const v = data[i];
    if (typeof v === 'number' && v !== 0) return true;
    if (Array.isArray(v) && v.some(x => x !== 0)) return true;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if (JSON.stringify(v) !== '{}') return true;
    }
  }
  return false;
}

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
      inputs.set('viewport_size', [512, 512]);

      const builtins = new Map<string, RuntimeValue>();
      builtins.set('time', 1.0);
      builtins.set('delta_time', 0.016);

      const context = await backend.execute(ir, 'fn_main_cpu', inputs, builtins);

      // Verify the particles buffer was modified from initial zeros
      const particles = context.getResource('particles');
      expect(particles.data).toBeDefined();

      const bufData = particles.data as any[];
      expect(hasNonZeroData(bufData, 60), 'Particle buffer should have non-zero data after simulation').toBe(true);

      // Verify particle fields are in reasonable range for alive particles
      for (let p = 0; p < 10; p++) {
        const { lt, age } = getParticle(bufData, p);
        // Freshly respawned particles should have lifetime > 0
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
