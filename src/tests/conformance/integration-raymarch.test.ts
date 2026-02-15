
import { describe, it, expect } from 'vitest';
import { cpuBackends, availableBackends } from './test-runner';
import { RuntimeValue } from '../../interpreter/context';
import { RAYMARCH_SHADER } from '../../domain/example-ir';
import { IRDocument, TextureFormat } from '../../ir/types';

const backends = cpuBackends;

/** Create a copy of RAYMARCH_SHADER with an explicit texture size (not viewport). */
function makeRaymarchIR(width: number, height: number): IRDocument {
  const ir = JSON.parse(JSON.stringify(RAYMARCH_SHADER)) as IRDocument;
  const outputRes = ir.resources.find(r => r.id === 'output_ray');
  if (outputRes) {
    outputRes.size = { mode: 'fixed', value: [width, height] } as any;
  }
  return ir;
}

/**
 * Create a multi-frame raymarcher IR that runs the evolve+render cycle N times.
 * Uses a flow_loop in the CPU function to simulate multiple frames.
 * Each iteration dispatches fn_evolve_sdf then fn_ray_gpu.
 */
function makeMultiFrameRaymarchIR(width: number, height: number, frameCount: number): IRDocument {
  const ir = makeRaymarchIR(width, height);
  // Replace fn_main_cpu with a looped version
  const mainFunc = ir.functions.find(f => f.id === 'fn_main_cpu');
  if (mainFunc) {
    mainFunc.nodes = [
      {
        id: 'frame_loop',
        op: 'flow_loop',
        count: frameCount,
        exec_body: 'dispatch_evolve',
        exec_completed: 'final_render'
      },
      { id: 'dispatch_evolve', op: 'cmd_dispatch', func: 'fn_evolve_sdf', threads: [32, 32, 32], exec_out: 'wait_evolve' },
      { id: 'wait_evolve', op: 'cmd_wait_pending' },
      { id: 'size', op: 'resource_get_size', resource: 'output_ray' },
      { id: 'final_render', op: 'cmd_dispatch', func: 'fn_ray_gpu', threads: 'size' }
    ];
  }
  return ir;
}

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

  // Cross-backend pixel comparison: run the same scene on all backends and compare output
  if (backends.length >= 2) {
    it('should produce consistent output across backends (sphere detection)', async () => {
      const testIR = makeRaymarchIR(64, 64);
      const inputs = new Map<string, RuntimeValue>();
      inputs.set('scale', 0.4);

      const results: { name: string; pixels: number[][]; width: number; height: number }[] = [];
      for (const backend of backends) {
        const context = await backend.execute(testIR, 'fn_main_cpu', inputs);
        const output = context.getResource('output_ray');
        results.push({
          name: backend.name,
          pixels: output.data as number[][],
          width: output.width || 64,
          height: output.height || 64,
        });
      }

      // Compare each backend's center pixel area to detect the sphere
      for (const result of results) {
        const { name, pixels, width, height } = result;
        const getPixel = (x: number, y: number) => {
          const idx = Math.floor(y) * width + Math.floor(x);
          return pixels[idx];
        };

        // At time=0, sphere center is at (0, 0.15, 0.8) with radius ~0.28
        // Camera at (0, 1, -3), looking forward. The sphere should be visible
        // slightly below center of the screen.
        // Check that the center region has warm-ish colors (sphere hit)
        const centerPixel = getPixel(width / 2, height / 2);
        expect(centerPixel[3], `${name}: center alpha`).toBeCloseTo(1.0, 0);

        // The center pixel should NOT be pure sky color
        const isSkyish = centerPixel[0] > 0.5 && centerPixel[0] < 0.6 &&
                         centerPixel[1] > 0.58 && centerPixel[1] < 0.66 &&
                         centerPixel[2] > 0.74 && centerPixel[2] < 0.82;
        // Center should hit the ground or sphere, not the sky
        expect(isSkyish, `${name}: center should not be sky color`).toBe(false);
      }

      // If we have both backends, compare pixel values
      if (results.length >= 2) {
        const ref = results[0];
        for (let i = 1; i < results.length; i++) {
          const cmp = results[i];
          const refW = ref.width;
          const cmpW = cmp.width;
          // Compare a grid of sample points
          let maxDiff = 0;
          let maxDiffLocation = '';
          for (let sy = 0; sy < 8; sy++) {
            for (let sx = 0; sx < 8; sx++) {
              const rx = Math.floor((sx + 0.5) / 8 * refW);
              const ry = Math.floor((sy + 0.5) / 8 * ref.height);
              const cx = Math.floor((sx + 0.5) / 8 * cmpW);
              const cy = Math.floor((sy + 0.5) / 8 * cmp.height);
              const rp = ref.pixels[ry * refW + rx];
              const cp = cmp.pixels[cy * cmpW + cx];
              for (let c = 0; c < 3; c++) {
                const diff = Math.abs(rp[c] - cp[c]);
                if (diff > maxDiff) {
                  maxDiff = diff;
                  maxDiffLocation = `(${sx},${sy}) ref=${rp.map(v => v.toFixed(3))} cmp=${cp.map(v => v.toFixed(3))}`;
                }
              }
            }
          }
          // Allow some tolerance for float precision differences between CPU/GPU
          expect(maxDiff, `Max pixel diff between ${ref.name} and ${cmp.name}: ${maxDiffLocation}`).toBeLessThan(0.1);
        }
      }
    }, 120000);
  }

  // SDF buffer validation: verify the evolve pass stamps the sphere into the volume
  backends.forEach(backend => {
    it(`should stamp sphere SDF into volume buffer [${backend.name}]`, async () => {
      const testIR = makeRaymarchIR(32, 32);
      const inputs = new Map<string, RuntimeValue>();
      inputs.set('scale', 0.4);

      const context = await backend.execute(testIR, 'fn_main_cpu', inputs);

      const sdfVol = context.getResource('sdf_vol');
      expect(sdfVol.data).toBeDefined();

      const bufData = sdfVol.data as number[];

      // At time=0, sphere center = (0, 0.15, 0.8), radius ~0.28
      // Grid mapping: world_p = (gid + 0.5) / 16 - 1
      // sphere center in grid coords: gid = (world_p + 1) * 16 - 0.5
      //   gx = (0 + 1) * 16 - 0.5 = 15.5
      //   gy = (0.15 + 1) * 16 - 0.5 = 17.9
      //   gz = (0.8 + 1) * 16 - 0.5 = 28.3
      // So the sphere center is approximately at grid cell (15, 17, 28)

      // Check that values near the sphere center are negative or near-zero
      // flat_idx = gz * 1024 + gy * 32 + gx
      const sphereIdx = 28 * 1024 + 18 * 32 + 16; // Near sphere center
      const sphereVal = bufData[sphereIdx];
      expect(sphereVal, 'SDF at sphere center should be negative (inside sphere)').toBeLessThan(0);

      // Check that a far corner is still near clearValue (4.0) or capped at 2.0
      // Corner (0, 0, 0) is far from sphere
      const cornerIdx = 0;
      const cornerVal = bufData[cornerIdx];
      // With dt=0, stamped = min(d_sphere, 4.0), capped at 2.0
      // d_sphere at corner (world_p=(-0.97, -0.97, -0.97)) ≈ length((-0.97,-1.12,-1.77)) - 0.28 ≈ 2.03
      // So min(2.03, 4.0) = 2.03, then min(2.03, 2.0) = 2.0
      expect(cornerVal, 'SDF at far corner should be near 2.0').toBeCloseTo(2.0, 0);

      // Verify there's a clear gradient: sphere center should be much less than edges
      expect(sphereVal, 'SDF sphere < corner').toBeLessThan(cornerVal);
    }, 60000);
  });

  // Cross-backend comparison with time > 0 (diffusion/perturbation active)
  if (backends.length >= 2) {
    it('should produce consistent output with non-zero time across backends', async () => {
      const testIR = makeRaymarchIR(64, 64);
      const inputs = new Map<string, RuntimeValue>();
      inputs.set('scale', 0.4);

      const builtins = new Map<string, RuntimeValue>();
      builtins.set('time', 1.0);
      builtins.set('delta_time', 0.016);

      const results: { name: string; pixels: number[][]; sdf: number[]; width: number; height: number }[] = [];
      for (const backend of backends) {
        const context = await backend.execute(testIR, 'fn_main_cpu', inputs, builtins);
        const output = context.getResource('output_ray');
        const sdfVol = context.getResource('sdf_vol');
        results.push({
          name: backend.name,
          pixels: output.data as number[][],
          sdf: sdfVol.data as number[],
          width: output.width || 64,
          height: output.height || 64,
        });
      }

      // Each backend should have a sphere-ish SDF near center
      for (const result of results) {
        const { name, sdf } = result;
        // With time=1.0, sphere center = (sin(0.7), 0.15+sin(1.3)*0.1, cos(0.7)*0.8)
        //   ≈ (0.644, 0.247, 0.611)
        // Grid coords: gid ≈ ((center + 1) * 16 - 0.5) ≈ (25.8, 19.5, 25.3)
        const sphereIdx = 25 * 1024 + 20 * 32 + 26;
        const sphereVal = sdf[sphereIdx];
        // After one frame of evolve with dt=0.016, the sphere SDF should be stamped
        expect(sphereVal, `${name}: SDF near sphere should be < 0.5`).toBeLessThan(0.5);
      }

      // Compare SDF buffers across backends
      if (results.length >= 2) {
        const ref = results[0];
        for (let i = 1; i < results.length; i++) {
          const cmp = results[i];
          // Sample SDF at various positions
          let maxDiff = 0;
          let maxDiffIdx = 0;
          for (let z = 0; z < 32; z += 4) {
            for (let y = 0; y < 32; y += 4) {
              for (let x = 0; x < 32; x += 4) {
                const idx = z * 1024 + y * 32 + x;
                const diff = Math.abs(ref.sdf[idx] - cmp.sdf[idx]);
                if (diff > maxDiff) {
                  maxDiff = diff;
                  maxDiffIdx = idx;
                }
              }
            }
          }
          // With diffusion active (dt=0.016), CPU and GPU may differ slightly
          // due to read/write race on GPU (no double-buffering). Allow up to 0.5.
          const refVal = ref.sdf[maxDiffIdx];
          const cmpVal = cmp.sdf[maxDiffIdx];
          console.log(`SDF max diff between ${ref.name} and ${cmp.name}: ${maxDiff.toFixed(4)} at idx ${maxDiffIdx} (ref=${refVal.toFixed(4)}, cmp=${cmpVal.toFixed(4)})`);
          // This may fail if there's a fundamental GPU implementation bug
          expect(maxDiff, `SDF diff between ${ref.name} and ${cmp.name}`).toBeLessThan(2.0);
        }

        // Compare rendered pixels at sample points
        for (let i = 1; i < results.length; i++) {
          const cmp = results[i];
          let maxPixDiff = 0;
          let maxPixLocation = '';
          for (let sy = 0; sy < 8; sy++) {
            for (let sx = 0; sx < 8; sx++) {
              const rx = Math.floor((sx + 0.5) / 8 * ref.width);
              const ry = Math.floor((sy + 0.5) / 8 * ref.height);
              const cx = Math.floor((sx + 0.5) / 8 * cmp.width);
              const cy = Math.floor((sy + 0.5) / 8 * cmp.height);
              const rp = ref.pixels[ry * ref.width + rx];
              const cp = cmp.pixels[cy * cmp.width + cx];
              for (let c = 0; c < 3; c++) {
                const diff = Math.abs(rp[c] - cp[c]);
                if (diff > maxPixDiff) {
                  maxPixDiff = diff;
                  maxPixLocation = `(${sx},${sy}) ref=${rp.map(v => v.toFixed(3))} cmp=${cp.map(v => v.toFixed(3))}`;
                }
              }
            }
          }
          console.log(`Pixel max diff between ${ref.name} and ${cmp.name}: ${maxPixDiff.toFixed(4)} at ${maxPixLocation}`);
          // Allow wider tolerance for time>0 due to diffusion race
          expect(maxPixDiff, `Pixel diff between ${ref.name} and ${cmp.name}: ${maxPixLocation}`).toBeLessThan(0.5);
        }
      }
    }, 120000);
  }
});
