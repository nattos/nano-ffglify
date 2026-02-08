
import { describe, it, expect } from 'vitest';
import { availableBackends } from './test-runner';
import { IRDocument, TextureFormat } from '../../ir/types';

describe('Compliance: Texture Sampling Modes', () => {

  // Helper to create fresh IR for each test
  const getIR = (filter: 'nearest' | 'linear', wrap: 'clamp' | 'repeat' | 'mirror', u: number, v: number): IRDocument => {
    return {
      version: '1.0.0',
      meta: { name: 'Sampling Modes' },
      entryPoint: 'main',
      inputs: [],
      resources: [
        {
          id: 't_check',
          type: 'texture2d',
          size: { mode: 'fixed', value: [2, 2] },
          format: TextureFormat.R32F,
          sampler: { filter, wrap },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
        },
        {
          id: 'b_res',
          type: 'buffer',
          dataType: 'float4', // Use float4 as per original test override
          size: { mode: 'fixed', value: 1 },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
        }
      ],
      structs: [],
      functions: [
        {
          id: 'main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'n1', op: 'texture_sample', tex: 't_check', coords: [u, v], _next: 'n2' },
            { id: 'n2', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'n1' }
          ]
        }
      ]
    };
  };

  availableBackends.forEach(backend => {
    describe(`Backend: ${backend.name}`, () => {

      it('should interpolate linearly', async () => {
        // U = 0.5 (Midpoint of 0 and 1). Expect 0.5
        // V = 0.25 (Row 0).
        const ir = getIR('linear', 'clamp', 0.5, 0.25);

        const ctx = await backend.createContext(ir);

        // Setup Texture Data
        const tex = ctx.resources.get('t_check');
        tex.data = [0, 1, 0, 1]; // Flattened 2x2. Row 0: 0,1. Row 1: 0,1.
        tex.width = 2;
        tex.height = 2;

        await backend.run(ctx, 'main');

        const res = ctx.resources.get('b_res');
        // Interpreter might store as array of arrays or flat array depending on implementation
        // But getVar/getResource logic usually standardizes.
        // float4 output implies array of 4 or similar.
        // Let's inspect the structure safely.

        let val = 0;
        if (Array.isArray(res.data) && Array.isArray(res.data[0])) {
          val = (res.data[0] as any)[0]; // float4[0].x
        } else if (Array.isArray(res.data)) {
          val = res.data[0] as number;
        }

        expect(val).toBeCloseTo(0.5, 2);
        ctx.destroy();
      });

      it('should mirror wrap', async () => {
        // Test 1.25 -> 0.75 -> Val 1 (Pixel 1)
        const ir1 = getIR('nearest', 'mirror', 1.25, 0.25);
        const ctx1 = await backend.createContext(ir1);
        const tex1 = ctx1.resources.get('t_check');
        tex1.data = [0, 1, 0, 1];
        tex1.width = 2; tex1.height = 2;

        await backend.run(ctx1, 'main');

        let val1 = 0;
        const res1 = ctx1.resources.get('b_res');
        if (Array.isArray(res1.data) && Array.isArray(res1.data[0])) val1 = (res1.data[0] as any)[0];
        else if (Array.isArray(res1.data)) val1 = res1.data[0] as number;

        expect(val1).toBe(1);
        ctx1.destroy();


        // Test 1.75 -> 0.25 -> Val 0 (Pixel 0)
        const ir2 = getIR('nearest', 'mirror', 1.75, 0.25);
        const ctx2 = await backend.createContext(ir2);
        const tex2 = ctx2.resources.get('t_check');
        tex2.data = [0, 1, 0, 1];
        tex2.width = 2; tex2.height = 2;

        await backend.run(ctx2, 'main');

        let val2 = 0;
        const res2 = ctx2.resources.get('b_res');
        if (Array.isArray(res2.data) && Array.isArray(res2.data[0])) val2 = (res2.data[0] as any)[0];
        else if (Array.isArray(res2.data)) val2 = res2.data[0] as number;

        expect(val2).toBe(0);
        ctx2.destroy();
      });

    });
  });
});
