
import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { RAYMARCH_SHADER } from '../../domain/example-ir';

const backends = cpuBackends;

describe('Conformance: Integration - Raymarcher', () => {
  if (backends.length === 0) {
    it.skip('Skipping tests (no compatible backend)', () => { });
    return;
  }

  const ir = RAYMARCH_SHADER;

  backends.forEach(backend => {
    it(`should execute the Raymarcher pipeline [${backend.name}]`, async () => {
      // Set viewport size to ensure we have enough pixels to resolve the scene
      if (backend.resize) {
        backend.resize(64, 64);
      }

      const inputs = new Map<string, RuntimeValue>();
      inputs.set('scale', 0.4);

      try {
        const context = await backend.execute(ir, 'fn_main_cpu', inputs);

        const output = context.getResource('output_ray');
        expect(output.data).toBeDefined();

        const pixelData = output.data as number[][]; // Array of [r, g, b, a]
        const width = output.width || Math.sqrt(pixelData.length);
        const height = output.height || width;

        const getPixel = (x: number, y: number) => {
          const idx = Math.floor(y) * width + Math.floor(x);
          return pixelData[idx];
        };

        // Center pixel — with animated sphere at time=0 (sphere at z=0.8, x=0)
        // and camera at (0, 1.0, -3.0), center should hit the sphere or ground.
        // The sphere has warm orange color (R ~0.9) and the floor is grey.
        // With fog and shading, values will be modulated. Just verify non-zero rendering.
        const centerPixel = getPixel(width / 2, height / 2);
        expect(centerPixel[3], 'Center A').toBeCloseTo(1.0, 0);

        const edgePixel = getPixel(1, 1);

        // With the animated scene, verify rendering produced non-trivial output
        const hasSomeVariation =
          Math.abs(centerPixel[0] - edgePixel[0]) > 0.001 ||
          Math.abs(centerPixel[1] - edgePixel[1]) > 0.001 ||
          Math.abs(centerPixel[2] - edgePixel[2]) > 0.001;
        expect(hasSomeVariation, 'Scene should have pixel variation between center and edge').toBe(true);

        // Corner pixel (0,0) — should be a miss (sky/fog color ~0.55, 0.62, 0.78)
        const cornerPixel = getPixel(0, 0);
        expect(cornerPixel[3], 'Corner A').toBeCloseTo(1.0, 0);

      } catch (e: any) {
        if (e.message.includes('WebGPU Error') || e.message.includes('WGSL')) {
          console.error("WGSL Compilation Error. Inspecting IR and generated code...");
        }
        throw e;
      }
    });
  });
});
