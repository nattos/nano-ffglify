import { describe, it, expect } from 'vitest';
import { availableBackends } from './test-runner';
import { IRDocument } from '../../ir/types';

describe('Conformance: Texture Sampling', () => {

  const wrapModeIr: IRDocument = {
    version: '3.0.0',
    meta: { name: 'Sampler Test' },
    entryPoint: 'fn_main',
    inputs: [],
    structs: [],
    resources: [
      {
        id: 't_src',
        type: 'texture2d',
        format: 'rgba8',
        size: { mode: 'fixed', value: [2, 2] },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false },
        sampler: { filter: 'nearest', wrap: 'repeat' } // Mutated in tests
      },
      {
        id: 'b_result',
        type: 'buffer',
        dataType: 'float4',
        size: { mode: 'fixed', value: 1 },
        persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
      }
    ],
    functions: [
      {
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'call', op: 'cmd_dispatch', func: 'fn_sample', dispatch: [1, 1, 1] }
        ]
      },
      {
        id: 'fn_sample',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'uv', op: 'float2', x: 0.0, y: 0.0 }, // Mutated in tests
          { id: 'sample', op: 'texture_sample', tex: 't_src', uv: 'uv' },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'sample' }
        ]
      }
    ]
  };

  const getIR = (wrap: 'repeat' | 'clamp', u: number, v: number): IRDocument => {
    const ir = JSON.parse(JSON.stringify(wrapModeIr)); // Clone
    ir.resources[0].sampler.wrap = wrap;
    ir.functions[1].nodes[0].x = u;
    ir.functions[1].nodes[0].y = v;
    ir.meta.name = `Sampler Test ${wrap}`;
    return ir;
  };

  availableBackends.forEach(backend => {
    it(`should sample texture with Wrap Mode Repeat [${backend.name}]`, async () => {
      // 1.5, 0.5 with Repeat -> 0.5, 0.5 -> Index 3 (White)
      const ir = getIR('repeat', 1.5, 0.5);
      const ctx = await backend.createContext(ir);

      const tex = ctx.getResource('t_src');
      tex.width = 2;
      tex.height = 2;
      tex.data = [
        [1, 0, 0, 1], [0, 1, 0, 1],
        [0, 0, 1, 1], [1, 1, 1, 1]
      ];

      await backend.run(ctx, ir.entryPoint);

      const buf = ctx.getResource('b_result');
      expect(buf.data?.[0]).toEqual([1, 1, 1, 1]);
    });

    it(`should sample texture with Wrap Mode Clamp [${backend.name}]`, async () => {
      // -0.5, 0.5 with Clamp -> 0.0, 0.5 -> Index 2 (Blue)
      const ir = getIR('clamp', -0.5, 0.5);
      const ctx = await backend.createContext(ir);

      const tex = ctx.getResource('t_src');
      tex.width = 2;
      tex.height = 2;
      tex.data = [
        [1, 0, 0, 1], [0, 1, 0, 1],
        [0, 0, 1, 1], [1, 1, 1, 1]
      ];

      await backend.run(ctx, ir.entryPoint);

      const buf = ctx.getResource('b_result');
      expect(buf.data?.[0]).toEqual([0, 0, 1, 1]);
    });

    it(`should handle Format and Clear Operations [${backend.name}]`, async (testCtx) => {
      if (backend.name === 'Puppeteer') {
        testCtx.skip();
      }
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: 'Format Test' },
        entryPoint: 'fn_main',
        inputs: [],
        structs: [],
        resources: [
          {
            id: 't_internal',
            type: 'texture2d',
            format: 'r32f', // Explicitly set format
            size: { mode: 'fixed', value: [1, 1] },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: true, clearValue: [1, 0, 1, 1], cpuAccess: true }
          }
        ],
        functions: [
          {
            id: 'fn_main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              // Removed dynamic const_get for format
              {
                id: 'resize',
                op: 'cmd_resize_resource',
                resource: 't_internal',
                size: [2, 2],
                // Removed format arg
                clear: [0.5, 0, 0, 1]
              },
              { id: 'get_fmt', op: 'resource_get_format', resource: 't_internal' }
            ]
          }
        ]
      };

      const ctx = await backend.createContext(ir);

      // Initial State
      const tex = ctx.getResource('t_internal');
      expect(tex.data?.[0]).toEqual([1, 0, 1, 1]);

      await backend.run(ctx, ir.entryPoint);

      // Verify Resize & Format Change
      expect(tex.width).toBe(2);
      expect(tex.height).toBe(2);
      expect(tex.def.format).toBe('r32f');

      // Verify Explicit Clear
      expect(tex.data?.[0]).toEqual([0.5, 0, 0, 1]);
    });
  });
});
