import { describe, it, expect } from 'vitest';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Control Flow', () => {

  const commonResourcesResourceDef =
  {
    id: 'b_result',
    type: 'buffer',
    size: { mode: 'fixed', value: 1 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
  };

  it('should execute Branch (True path)', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Branch Test' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [commonResourcesResourceDef] as any,
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'branch', op: 'flow_branch', cond: true },
          { id: 'set_true', op: 'buffer_store', buffer: 'b_result', index: 0, value: 1 },
          { id: 'set_false', op: 'buffer_store', buffer: 'b_result', index: 0, value: 2 }
        ],
        edges: [
          { from: 'branch', portOut: 'exec_true', to: 'set_true', portIn: 'exec_in', type: 'execution' },
          { from: 'branch', portOut: 'exec_false', to: 'set_false', portIn: 'exec_in', type: 'execution' }
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(1);
  });

  it('should execute Branch (False path)', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Branch Test False' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [commonResourcesResourceDef] as any,
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'branch', op: 'flow_branch', cond: false },
          { id: 'set_true', op: 'buffer_store', buffer: 'b_result', index: 0, value: 1 },
          { id: 'set_false', op: 'buffer_store', buffer: 'b_result', index: 0, value: 2 }
        ],
        edges: [
          { from: 'branch', portOut: 'exec_true', to: 'set_true', portIn: 'exec_in', type: 'execution' },
          { from: 'branch', portOut: 'exec_false', to: 'set_false', portIn: 'exec_in', type: 'execution' }
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(2);
  });

  it('should execute Loop (Accumulate Index)', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Loop Test' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [commonResourcesResourceDef] as any,
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [{ id: 'acc', type: 'int', initialValue: 0 }],
        nodes: [
          // Loop 0 to 5
          { id: 'loop', op: 'flow_loop', start: 0, end: 5 },
          { id: 'idx', op: 'loop_index', loop: 'loop' },
          { id: 'curr', op: 'var_get', var: 'acc' },
          { id: 'add', op: 'math_add', a: 'curr', b: 'idx' }, // acc + idx
          { id: 'update', op: 'var_set', var: 'acc', val: 'add' },
          // Store result after loop
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'acc' }
        ],
        edges: [
          // Loop Body Execution
          { from: 'loop', portOut: 'exec_body', to: 'update', portIn: 'exec_in', type: 'execution' },
          // Loop Completed (Store result)
          { from: 'loop', portOut: 'exec_completed', to: 'store', portIn: 'exec_in', type: 'execution' },

          // Data Flow
          // Update 'acc'
          { from: 'curr', portOut: 'val', to: 'add', portIn: 'a', type: 'data' },
          { from: 'idx', portOut: 'val', to: 'add', portIn: 'b', type: 'data' },
          { from: 'add', portOut: 'val', to: 'update', portIn: 'val', type: 'data' },

          // Final Store Logic:
          // 1. Loop finishes all iterations (updating 'acc' 5 times).
          // 2. Loop triggers 'exec_completed' edge.
          // 3. 'store' executes.
          // 4. 'store' resolves input 'value' ('acc').
          // 5. It reads the FINAL value of 'acc' from the context.
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const res = ctx.getResource('b_result');
    // Sum 0+1+2+3+4 = 10
    expect(res.data?.[0]).toBe(10);
  });

});
