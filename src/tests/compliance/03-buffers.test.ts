import { describe, it, expect } from 'vitest';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';
import { validateIR } from '../../ir/validator';

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

  it('should throw Runtime Error on OOB Write', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Buffer OOB Write' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [
        { id: 'buf', type: 'buffer', size: { mode: 'fixed', value: 2 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }
      ],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'store_oob', op: 'buffer_store', buffer: 'buf', index: 5, value: 100 }
        ],
        edges: []
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);

    // Validates statically first
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Static OOB');
  });

  it('should throw Runtime Error on OOB Read', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Buffer OOB Read' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [
        { id: 'buf', type: 'buffer', size: { mode: 'fixed', value: 2 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }
      ],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'read_oob', op: 'buffer_load', buffer: 'buf', index: 5 },
          { id: 'sink', op: 'var_set', var: 'x', val: 'read_oob' } // Ensure execution
        ],
        edges: [
          // Need edge to pass data? No, buffer_load uses args directly usually.
          // Wait, previous test didn't use edges for args?
          // buffer_store uses 'buffer' (string ID) and 'index' (number).
          // If index is literal, no edge needed.
          // buffer_load return value needs to be used.
          // sink uses 'val': 'read_oob'.
          // Without edge, sink.val='read_oob' (string).
          // var_set sets 'x' = "read_oob".
          // read_oob is NOT executed!
          // I MUST add edge to force execution of read_oob!
          { from: 'read_oob', portOut: 'val', to: 'sink', portIn: 'val', type: 'data' }
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);

    // Validates statically first
    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Static OOB');
  });

});
