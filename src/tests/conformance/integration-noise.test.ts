import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { NOISE_SHADER } from '../../domain/example-ir';

const backends = cpuBackends;

describe('Conformance: Integration - Noise Generator', () => {
  if (backends.length === 0) {
    it.skip('Skipping tests (no compatible backend)', () => { });
    return;
  }

  const ir = NOISE_SHADER;

  backends.forEach(backend => {
    it(`should execute the Noise Generator pipeline [${backend.name}]`, async () => {
      const inputs = new Map<string, RuntimeValue>();
      inputs.set('scale', 10.0);

      try {
        const context = await backend.execute(ir, 'fn_main_cpu', inputs);

        // Verify the output texture contains non-zero noise in RGB channels
        const output = context.getResource('output_tex');
        expect(output.data).toBeDefined();

        const pixelData = output.data as number[][];
        let hasRgbNoise = false;
        let firstPixel = pixelData[0];
        let hasVariance = false;

        for (const pixel of pixelData) {
          // Check if RGB are non-zero
          if (pixel[0] > 0 || pixel[1] > 0 || pixel[2] > 0) {
            hasRgbNoise = true;
          }
          // Check for variance (noise shouldn't be a solid color)
          if (pixel[0] !== firstPixel[0] || pixel[1] !== firstPixel[1] || pixel[2] !== firstPixel[2]) {
            hasVariance = true;
          }
          if (hasRgbNoise && hasVariance) break;
        }

        expect(hasRgbNoise, "Should have non-zero noise in RGB channels").toBe(true);
        expect(hasVariance, "Should have variance in noise values (not a solid color)").toBe(true);
      } catch (e: any) {
        // If it's a WebGPU/WGSL error, try to get the compiled code and log it
        if (e.message.includes('WebGPU Error') || e.message.includes('WGSL')) {
          console.error("WGSL Compilation Error. Inspecting IR and generated code...");
          // We can't easily get the code from here unless the backend exposes it.
          // But we know ForceOntoGPU uses WgslGenerator.
        }
        throw e;
      }
    }, 30000);
  });
});
