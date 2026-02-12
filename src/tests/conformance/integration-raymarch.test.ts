
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
      // Set viewport size to ensure we have enough pixels to resolve the sphere
      if (backend.resize) {
        backend.resize(64, 64);
      }

      const inputs = new Map<string, RuntimeValue>();
      inputs.set('time', 0.0);

      // We need a reasonable size to ensure we hit the sphere in the center and miss in corners
      // The shader uses 'viewport' size. We can simulate this by setting the resource size or mocking it?
      // Actually CPU backend usually respects the buffer size if allocated?
      // Unlike WebGPU, CPU backend "output" buffers are usually allocated by the runtime or test harness.
      // Wait, 'resource_get_size' is used. In CPU backend, this comes from the bound resource.
      // The test harness in `cpuBackends` (Interpreter) normally allocates outputs based on resource def?
      // Let's look at `backend.execute`. It likely handles standard allocation or we rely on defaults.
      // 'size: { mode: 'viewport' }' might default to something small if not specified.
      // Let's check `backend.execute` signature or just try running it.
      // Usually defaults to 100x100 or something if not driven by a canvas.

      try {
        const context = await backend.execute(ir, 'fn_main_cpu', inputs);

        const output = context.getResource('output_ray');
        expect(output.data).toBeDefined();

        const pixelData = output.data as number[][]; // Array of [r, g, b, a]
        const width = output.width || Math.sqrt(pixelData.length); // Assume square if width missing
        const height = output.height || width;

        // Helper to get pixel at (x, y)
        const getPixel = (x: number, y: number) => {
          // Basic row-major mapping if flattened, or array of arrays?
          // Interpreter usually returns flat array of pixels or array of pixel arrays.
          // Type says `number[][]`, so it's `pixels[index][channel]`.
          // Index = y * width + x
          const idx = Math.floor(y) * width + Math.floor(x);
          return pixelData[idx];
        };

        // Center pixel (should hit sphere -> Red)
        const centerPixel = getPixel(width / 2, height / 2);
        // Expect Red: R ~ 1, G ~ 0, B ~ 0
        expect(centerPixel[0], 'Center R').toBeCloseTo(1.0, 1); // Hit color is red
        expect(centerPixel[1], 'Center G').toBeCloseTo(0.0, 1);
        expect(centerPixel[2], 'Center B').toBeCloseTo(0.0, 1);

        // Corner pixel (0,0) (should miss sphere -> Black)
        const cornerPixel = getPixel(0, 0);
        // Expect Black
        expect(cornerPixel[0], 'Corner R').toBeCloseTo(0.0, 1);
        expect(cornerPixel[1], 'Corner G').toBeCloseTo(0.0, 1);
        expect(cornerPixel[2], 'Corner B').toBeCloseTo(0.0, 1);

      } catch (e: any) {
        if (e.message.includes('WebGPU Error') || e.message.includes('WGSL')) {
          console.error("WGSL Compilation Error. Inspecting IR and generated code...");
        }
        throw e;
      }
    }); // Increase timeout if needed
  });
});
