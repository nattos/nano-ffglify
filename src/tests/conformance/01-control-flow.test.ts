import { describe, expect } from 'vitest';
import { runParametricTest } from './test-runner';

describe('Conformance: Control Flow', () => {

  const commonResourcesResourceDef =
  {
    id: 'b_result',
    type: 'buffer',
    size: { mode: 'fixed', value: 1 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
  };

  runParametricTest('should execute Branch (True path)', [
    { id: 'branch', op: 'flow_branch', cond: true },
    { id: 'set_true', op: 'buffer_store', buffer: 'b_result', index: 0, value: 1 },
    { id: 'set_false', op: 'buffer_store', buffer: 'b_result', index: 0, value: 2 }
  ], (ctx) => {
    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(1);
  }, [commonResourcesResourceDef], [
    { from: 'branch', portOut: 'exec_true', to: 'set_true', portIn: 'exec_in', type: 'execution' },
    { from: 'branch', portOut: 'exec_false', to: 'set_false', portIn: 'exec_in', type: 'execution' }
  ]);

  runParametricTest('should execute Branch (False path)', [
    { id: 'branch', op: 'flow_branch', cond: false },
    { id: 'set_true', op: 'buffer_store', buffer: 'b_result', index: 0, value: 1 },
    { id: 'set_false', op: 'buffer_store', buffer: 'b_result', index: 0, value: 2 }
  ], (ctx) => {
    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(2);
  }, [commonResourcesResourceDef], [
    { from: 'branch', portOut: 'exec_true', to: 'set_true', portIn: 'exec_in', type: 'execution' },
    { from: 'branch', portOut: 'exec_false', to: 'set_false', portIn: 'exec_in', type: 'execution' }
  ]);

  runParametricTest('should execute Loop (Accumulate Index)', [
    // Loop 0 to 5
    { id: 'loop', op: 'flow_loop', start: 0, end: 5 },
    { id: 'idx', op: 'loop_index', loop: 'loop' },
    { id: 'curr', op: 'var_get', var: 'acc' },
    { id: 'add', op: 'math_add', a: 'curr', b: 'idx' }, // acc + idx
    { id: 'update', op: 'var_set', var: 'acc', val: 'add' },
    // Store result after loop
    { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'acc' }
  ], (ctx) => {
    const res = ctx.getResource('b_result');
    // Sum 0+1+2+3+4 = 10
    expect(res.data?.[0]).toBe(10);
  }, [commonResourcesResourceDef], [
    // Loop Body Execution
    { from: 'loop', portOut: 'exec_body', to: 'update', portIn: 'exec_in', type: 'execution' },
    // Loop Completed (Store result)
    { from: 'loop', portOut: 'exec_completed', to: 'store', portIn: 'exec_in', type: 'execution' }
    // Data edges are auto-wired by buildSimpleIR assuming IDs match property values
  ], [{ id: 'acc', type: 'int', initialValue: 0 }]);

});
