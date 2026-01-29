import { describe, it, expect } from 'vitest';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Buffers', () => {

  it('should handle Resize and Clear', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Buffer Resize' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [
        {
          id: 'buf',
          type: 'buffer',
          size: { mode: 'fixed', value: 2 }, // Init size 2
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: true, cpuAccess: false }
        }
      ],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          // 1. Write data
          { id: 'store', op: 'buffer_store', buffer: 'buf', index: 0, value: 50 },
          // 2. Resize
          { id: 'resize', op: 'cmd_resize_resource', resource: 'buf', size: 10 }
        ],
        edges: [
          { from: 'store', portOut: 'exec_out', to: 'resize', portIn: 'exec_in', type: 'execution' }
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const res = ctx.getResource('buf');
    expect(res.width).toBe(10);
    // clearOnResize = true, so data should be empty or cleared. My ops.ts implementation: `if (clear) res.data = []`.
    expect(res.data).toEqual(new Array(10).fill(0));
  });

  it('should ignore OOB Writes and return 0 for OOB Reads', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Buffer OOB' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [
        {
          id: 'buf',
          type: 'buffer',
          size: { mode: 'fixed', value: 2 }, // Size 2 [0, 1]
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
        },
        {
          id: 'res',
          type: 'buffer',
          size: { mode: 'fixed', value: 2 },
          persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
        }
      ],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          // Write 100 to index 5 (OOB)
          { id: 'store_oob', op: 'buffer_store', buffer: 'buf', index: 5, value: 100 },
          // Write 200 to index 0 (Valid)
          { id: 'store_ok', op: 'buffer_store', buffer: 'buf', index: 0, value: 200 },

          // Read index 5 (OOB), should be 0
          { id: 'read_oob', op: 'buffer_load', buffer: 'buf', index: 5 },
          // Read index 0, should be 200
          { id: 'read_ok', op: 'buffer_load', buffer: 'buf', index: 0 },

          { id: 'save_oob', op: 'buffer_store', buffer: 'res', index: 0, value: 'read_oob' },
          { id: 'save_ok', op: 'buffer_store', buffer: 'res', index: 1, value: 'read_ok' }
        ],
        edges: [
          { from: 'store_oob', portOut: 'exec_out', to: 'store_ok', portIn: 'exec_in', type: 'execution' },
          { from: 'store_ok', portOut: 'exec_out', to: 'save_oob', portIn: 'exec_in', type: 'execution' },
          { from: 'save_oob', portOut: 'exec_out', to: 'save_ok', portIn: 'exec_in', type: 'execution' },

          { from: 'read_oob', portOut: 'val', to: 'save_oob', portIn: 'value', type: 'data' },
          { from: 'read_ok', portOut: 'val', to: 'save_ok', portIn: 'value', type: 'data' }
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());



    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const buf = ctx.getResource('buf');
    // Verify OOB Store ignored
    expect(buf.data?.[5]).toBeUndefined();
    expect(buf.data?.[0]).toBe(200);

    const res = ctx.getResource('res');
    // Verify Read OOB was 0
    expect(res.data?.[0]).toBe(0);
    expect(res.data?.[1]).toBe(200);
  });

});
