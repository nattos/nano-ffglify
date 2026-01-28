import { describe, it, expect } from 'vitest';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Texture Sampling', () => {

  it('should sample texture with Wrap Mode Repeat', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Sampler Test' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [
        {
          id: 't_src',
          type: 'texture2d',
          size: { mode: 'fixed', value: [2, 2] },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false },
          sampler: { filter: 'nearest', wrap: 'repeat' }
        },
        {
          id: 'b_result',
          type: 'buffer',
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
          ],
          edges: []
        },
        {
          id: 'fn_sample',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            // Sample at (1.5, 0.5). With Repeat -> (0.5, 0.5) -> Index 3 (White)
            { id: 'uv', op: 'vec2', x: 1.5, y: 0.5 },
            { id: 'sample', op: 'texture_sample', tex: 't_src', uv: 'uv' },
            { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'sample' }
          ],
          edges: [
            { from: 'uv', portOut: 'val', to: 'sample', portIn: 'uv', type: 'data' },
            { from: 'sample', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
          ]
        }
      ]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const tex = ctx.getResource('t_src');
    tex.width = 2;
    tex.height = 2;
    tex.data = [
      [1, 0, 0, 1], [0, 1, 0, 1],
      [0, 0, 1, 1], [1, 1, 1, 1]
    ];

    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const buf = ctx.getResource('b_result');
    expect(buf.data?.[0]).toEqual([1, 1, 1, 1]);
  });

  it('should sample texture with Wrap Mode Clamp', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Sampler Test Clamp' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [
        {
          id: 't_src',
          type: 'texture2d',
          size: { mode: 'fixed', value: [2, 2] },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false },
          sampler: { filter: 'nearest', wrap: 'clamp' }
        },
        {
          id: 'b_result',
          type: 'buffer',
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
          ],
          edges: []
        },
        {
          id: 'fn_sample',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            // Sample at (-0.5, 0.5) -> Clamp to (0.0, 0.5) -> Index 2 (Blue)
            { id: 'uv', op: 'vec2', x: -0.5, y: 0.5 },
            { id: 'sample', op: 'texture_sample', tex: 't_src', uv: 'uv' },
            { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'sample' }
          ],
          edges: [
            { from: 'uv', portOut: 'val', to: 'sample', portIn: 'uv', type: 'data' },
            { from: 'sample', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
          ]
        }
      ]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const tex = ctx.getResource('t_src');
    tex.width = 2;
    tex.height = 2;
    tex.data = [
      [1, 0, 0, 1], [0, 1, 0, 1],
      [0, 0, 1, 1], [1, 1, 1, 1]
    ];

    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const buf = ctx.getResource('b_result');
    expect(buf.data?.[0]).toEqual([0, 0, 1, 1]);
  });
});
