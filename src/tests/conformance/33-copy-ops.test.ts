import { describe, it, expect } from 'vitest';
import { cpuBackends } from './test-runner';
import { IRDocument } from '../../ir/types';

// Copy ops are CPU-only (cmd_copy_buffer, cmd_copy_texture).
const backends = cpuBackends;

describe('Conformance: Copy Ops', () => {
  if (backends.length === 0) {
    it.skip('Skipping copy ops tests (no compatible backend)', () => { });
    return;
  }

  // ================================================================
  // cmd_copy_buffer tests
  // ================================================================

  // Test 1: Full buffer copy (no offsets)
  const irFullBufferCopy: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Full Buffer Copy' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_src',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 4 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
      },
      {
        id: 'b_dst',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 4 },
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
          { id: 'copy', op: 'cmd_copy_buffer', src: 'b_src', dst: 'b_dst' }
        ]
      }
    ]
  };

  backends.forEach(backend => {
    it(`Full buffer copy [${backend.name}]`, async () => {
      const ctx = await backend.createContext(irFullBufferCopy);
      const src = ctx.getResource('b_src');
      src.data = [10, 20, 30, 40];
      const dst = ctx.getResource('b_dst');
      dst.data = [0, 0, 0, 0];

      await backend.run(ctx, 'main');

      const result = ctx.getResource('b_dst');
      expect(result.data![0]).toBeCloseTo(10);
      expect(result.data![1]).toBeCloseTo(20);
      expect(result.data![2]).toBeCloseTo(30);
      expect(result.data![3]).toBeCloseTo(40);
      ctx.destroy();
    });
  });

  // Test 2: Partial copy with offsets and count
  const irPartialBufferCopy: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Partial Buffer Copy' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_src',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 6 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
      },
      {
        id: 'b_dst',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 6 },
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
          { id: 'copy', op: 'cmd_copy_buffer', src: 'b_src', dst: 'b_dst', src_offset: 1, dst_offset: 2, count: 3 }
        ]
      }
    ]
  };

  backends.forEach(backend => {
    it(`Partial buffer copy with offsets [${backend.name}]`, async () => {
      const ctx = await backend.createContext(irPartialBufferCopy);
      const src = ctx.getResource('b_src');
      src.data = [10, 20, 30, 40, 50, 60];
      const dst = ctx.getResource('b_dst');
      dst.data = [1, 2, 3, 4, 5, 6];

      await backend.run(ctx, 'main');

      const result = ctx.getResource('b_dst');
      // dst[0..1] should be untouched, dst[2..4] = src[1..3]
      expect(result.data![0]).toBeCloseTo(1);
      expect(result.data![1]).toBeCloseTo(2);
      expect(result.data![2]).toBeCloseTo(20);
      expect(result.data![3]).toBeCloseTo(30);
      expect(result.data![4]).toBeCloseTo(40);
      expect(result.data![5]).toBeCloseTo(6);
      ctx.destroy();
    });
  });

  // Test 3: Copy between different-sized buffers (count clamped)
  const irDiffSizeBufferCopy: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Different Size Buffer Copy' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 'b_src',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 3 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
      },
      {
        id: 'b_dst',
        type: 'buffer',
        dataType: 'float',
        size: { mode: 'fixed', value: 5 },
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
          // No count specified: should copy min(3, 5) = 3 elements
          { id: 'copy', op: 'cmd_copy_buffer', src: 'b_src', dst: 'b_dst' }
        ]
      }
    ]
  };

  backends.forEach(backend => {
    it(`Buffer copy clamped to source size [${backend.name}]`, async () => {
      const ctx = await backend.createContext(irDiffSizeBufferCopy);
      const src = ctx.getResource('b_src');
      src.data = [100, 200, 300];
      const dst = ctx.getResource('b_dst');
      dst.data = [0, 0, 0, 0, 0];

      await backend.run(ctx, 'main');

      const result = ctx.getResource('b_dst');
      expect(result.data![0]).toBeCloseTo(100);
      expect(result.data![1]).toBeCloseTo(200);
      expect(result.data![2]).toBeCloseTo(300);
      expect(result.data![3]).toBeCloseTo(0);  // untouched
      expect(result.data![4]).toBeCloseTo(0);  // untouched
      ctx.destroy();
    });
  });

  // ================================================================
  // cmd_copy_texture tests
  // ================================================================

  // Test 4: Full texture copy (pixel-perfect)
  const irFullTextureCopy: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Full Texture Copy' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 't_src',
        type: 'texture2d',
        format: 'rgba32f',
        size: { mode: 'fixed', value: [2, 2] },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
      },
      {
        id: 't_dst',
        type: 'texture2d',
        format: 'rgba32f',
        size: { mode: 'fixed', value: [2, 2] },
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
          { id: 'copy', op: 'cmd_copy_texture', src: 't_src', dst: 't_dst' }
        ]
      }
    ]
  };

  backends.forEach(backend => {
    it(`Full texture copy [${backend.name}]`, async () => {
      const ctx = await backend.createContext(irFullTextureCopy);
      const src = ctx.getResource('t_src');
      src.width = 2; src.height = 2;
      src.data = [
        [1, 0, 0, 1], [0, 1, 0, 1],
        [0, 0, 1, 1], [1, 1, 1, 1]
      ];
      const dst = ctx.getResource('t_dst');
      dst.width = 2; dst.height = 2;
      dst.data = [
        [0, 0, 0, 0], [0, 0, 0, 0],
        [0, 0, 0, 0], [0, 0, 0, 0]
      ];

      await backend.run(ctx, 'main');

      const result = ctx.getResource('t_dst');
      expect(result.data![0]).toEqual([1, 0, 0, 1]);
      expect(result.data![1]).toEqual([0, 1, 0, 1]);
      expect(result.data![2]).toEqual([0, 0, 1, 1]);
      expect(result.data![3]).toEqual([1, 1, 1, 1]);
      ctx.destroy();
    });
  });

  // Test 5: Sub-rect copy with pixel coords
  const irSubRectCopy: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Sub-Rect Texture Copy' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 't_src',
        type: 'texture2d',
        format: 'rgba32f',
        size: { mode: 'fixed', value: [4, 4] },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
      },
      {
        id: 't_dst',
        type: 'texture2d',
        format: 'rgba32f',
        size: { mode: 'fixed', value: [4, 4] },
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
          // Copy a 2x2 region from src (1,1) to dst (2,2)
          { id: 'copy', op: 'cmd_copy_texture', src: 't_src', dst: 't_dst',
            src_rect: [1, 1, 2, 2], dst_rect: [2, 2, 2, 2] }
        ]
      }
    ]
  };

  backends.forEach(backend => {
    it(`Sub-rect texture copy [${backend.name}]`, async () => {
      const ctx = await backend.createContext(irSubRectCopy);
      const src = ctx.getResource('t_src');
      src.width = 4; src.height = 4;
      // Fill src with unique per-pixel colors
      src.data = new Array(16).fill(null).map((_, i) => [i * 0.1, 0, 0, 1]);
      const dst = ctx.getResource('t_dst');
      dst.width = 4; dst.height = 4;
      dst.data = new Array(16).fill(null).map(() => [0, 0, 0, 0]);

      await backend.run(ctx, 'main');

      const result = ctx.getResource('t_dst');
      // src pixel at (1,1) = index 5, should be at dst (2,2) = index 10
      // src pixel at (2,1) = index 6, should be at dst (3,2) = index 11
      // src pixel at (1,2) = index 9, should be at dst (2,3) = index 14
      // src pixel at (2,2) = index 10, should be at dst (3,3) = index 15
      expect(result.data![10][0]).toBeCloseTo(5 * 0.1);
      expect(result.data![11][0]).toBeCloseTo(6 * 0.1);
      expect(result.data![14][0]).toBeCloseTo(9 * 0.1);
      expect(result.data![15][0]).toBeCloseTo(10 * 0.1);
      // Untouched pixels should remain zero
      expect(result.data![0]).toEqual([0, 0, 0, 0]);
      ctx.destroy();
    });
  });

  // Test 6: Alpha blending copy
  const irAlphaBlendCopy: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Alpha Blend Texture Copy' },
    entryPoint: 'main',
    inputs: [],
    resources: [
      {
        id: 't_src',
        type: 'texture2d',
        format: 'rgba32f',
        size: { mode: 'fixed', value: [1, 1] },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
      },
      {
        id: 't_dst',
        type: 'texture2d',
        format: 'rgba32f',
        size: { mode: 'fixed', value: [1, 1] },
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
          { id: 'copy', op: 'cmd_copy_texture', src: 't_src', dst: 't_dst', alpha: 0.5 }
        ]
      }
    ]
  };

  backends.forEach(backend => {
    it(`Alpha blending texture copy [${backend.name}]`, async () => {
      const ctx = await backend.createContext(irAlphaBlendCopy);
      const src = ctx.getResource('t_src');
      src.width = 1; src.height = 1;
      src.data = [[1, 0, 0, 1]]; // Red, fully opaque
      const dst = ctx.getResource('t_dst');
      dst.width = 1; dst.height = 1;
      dst.data = [[0, 0, 1, 1]]; // Blue, fully opaque

      await backend.run(ctx, 'main');

      const result = ctx.getResource('t_dst');
      const pixel = result.data![0] as number[];
      // src.a = 1.0, alpha = 0.5 => srcA_eff = 0.5
      // outA = 0.5 + 1.0 * 0.5 = 1.0
      // outR = (1.0 * 0.5 + 0.0 * 1.0 * 0.5) / 1.0 = 0.5
      // outG = 0
      // outB = (0.0 * 0.5 + 1.0 * 1.0 * 0.5) / 1.0 = 0.5
      expect(pixel[0]).toBeCloseTo(0.5, 3);
      expect(pixel[1]).toBeCloseTo(0, 3);
      expect(pixel[2]).toBeCloseTo(0.5, 3);
      expect(pixel[3]).toBeCloseTo(1.0, 3);
      ctx.destroy();
    });
  });
});
