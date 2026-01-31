
import { describe, it, expect } from 'vitest';
import { ComputeTestBackend } from './compute-test-backend';
import { IRDocument } from '../../ir/types';

describe('Compliance: Texture Sampling Modes', () => {

  // define a simple 2x2 texture
  // [ 0.0, 1.0 ]
  // [ 0.0, 1.0 ]
  const ir: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Sampling Modes' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 't_check',
        type: 'texture2d',
        size: { mode: 'fixed', value: [2, 2] },
        format: 'r32f',
        sampler: { filter: 'linear', wrap: 'repeat' }, // vary this in tests
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
      },
      {
        id: 'b_res',
        type: 'buffer',
        dataType: 'float',
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
          { id: 'n1', op: 'texture_sample', tex: 't_check', uv: [0.5, 0.5] }, // UV will be overridden by tests
          { id: 'n2', op: 'buffer_store', buffer: 'b_res', index: 0 }
        ],
        edges: [
          { from: 'n1', portOut: 'val', to: 'n2', portIn: 'value', type: 'data' }
        ]
      }
    ]
  };

  // Fixup buffer type to float4 for easier testing
  ir.resources[1].dataType = 'float4';

  const setSampler = (filter: 'nearest' | 'linear', wrap: 'clamp' | 'repeat' | 'mirror') => {
    (ir.resources[0] as any).sampler = { filter, wrap };
  };

  const setUV = (u: number, v: number) => {
    ir.functions[0].nodes[0].uv = [u, v];
  };

  const runTest = async (u: number, v: number) => {
    setUV(u, v);
    // Data: 2x2 R32F
    // (0,0)=0, (1,0)=1
    // (0,1)=0, (1,1)=1
    const data = [0, 1, 0, 1];

    const ctx = await ComputeTestBackend.execute(ir, 'main');
    // Hack inject data
    // Actually we need to upload data. ComputeTestBackend.execute creates context but we can't inject data easily *before* run unless we use `createContext` manually.
    // But verify `execute` calls `createContext` then `run`.
    // We need to inject data into `t_check`.
    // Let's use `compute-test-backend`'s pattern: we pass input map, but resources are internal?
    // Actually `ComputeTestBackend` doesn't support pre-populating resources easily from outside unless they are INPUTS?
    // No, resources are state.
    // We need to mock the `t_check` data.
    // In `06-textures.test.ts`, we used `buffer_store` to write to it, or used `persistence`?
    // No, we used `cmd_resize_resource` or assumption?
    // Wait, `06-textures` uses `t_src` which is initialized by `writeTexture` logic in backend IIF `state.data` is present.
    // We need `state.data` to be present.
    // `createContext` initializes state. We can pass a `inputs` map, but that's for inputs.
    // Helpers in backend: `ctx.resources.get('t_check').data = [...]`.
    // But `execute` runs immediately.
    // We should manually verify by splitting execute.

    // RE-PLAN: Use split createContext / run.
  };

  // Re-write test to be split
  it('should interpolate linearly', async () => {
    setSampler('linear', 'clamp');
    // U = 0.5 (Midpoint of 0 and 1). Expect 0.5
    // V = 0.25 (Row 0).
    // Texel centers are at 0.25, 0.75 for 2px width?
    // 2px width:
    // Pixel 0: [0.0, 0.5] range, center 0.25
    // Pixel 1: [0.5, 1.0] range, center 0.75
    // value at 0.25 is 0.
    // value at 0.75 is 1.
    // Sample at 0.5 (exactly between centers). Should be 0.5.

    // Setup Context
    const ctx = await ComputeTestBackend.createContext(ir);
    // Write Data
    const tex = ctx.resources.get('t_check');
    tex.data = [0, 1, 0, 1]; // Flattened 2x2
    tex.width = 2;
    tex.height = 2;

    setUV(0.5, 0.25);

    await ComputeTestBackend.run(ctx, 'main');

    const res = ctx.resources.get('b_res');
    const r = res.data[0][0]; // float4[0].x

    expect(r).toBeCloseTo(0.5, 2);
  });

  it('should mirror wrap', async () => {
    setSampler('nearest', 'mirror');
    // 2px texture.
    // [0]=0 (Val 0), [1]=1 (Val 1).
    // Range [0..1] maps to texture.
    // > 1.0 starts mirroring.
    // 1.25:
    // 1.0 - 2.0 mirrors back from 1.0 to 0.0.
    // 1.25 corresponds to 0.75 in texture space.
    // 0.75 is center of Pixel 1 (Val 1).
    // Wait, Mirror Repeat math:
    // (1.25 - 0.5) * 2 = 1.5. abs...
    // Standard trace:
    // 1.1 -> 0.9
    // 1.25 -> 0.75
    // 1.75 -> 0.25
    // 1.9 -> 0.1

    // Sample at 1.25. Expect 0.75 equivalent -> Pixel 1 -> Value 1.
    // Sample at 1.75. Expect 0.25 equivalent -> Pixel 0 -> Value 0.

    const ctx = await ComputeTestBackend.createContext(ir);
    const tex = ctx.resources.get('t_check');
    tex.data = [0, 1, 0, 1];
    tex.width = 2; tex.height = 2;

    // Test 1.25 -> 0.75 -> Val 1
    setUV(1.25, 0.25);
    await ComputeTestBackend.run(ctx, 'main');
    expect(ctx.resources.get('b_res').data[0][0]).toBe(1);

    // Test 1.75 -> 0.25 -> Val 0
    setUV(1.75, 0.25);
    await ComputeTestBackend.run(ctx, 'main');
    expect(ctx.resources.get('b_res').data[0][0]).toBe(0);
  });
});
