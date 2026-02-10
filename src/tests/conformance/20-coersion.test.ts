import { describe, it } from 'vitest';
import { runFullGraphTest, availableBackends } from './test-runner';
import { IRDocument, FunctionDef, DataType, TextureFormat } from '../../ir/types';

describe('20-coersion', () => {
  const backends = availableBackends;

  if (backends.length === 0) {
    it.skip('Skipping Coersion tests for current backend', () => { });
    return;
  }


  // Test case 1: Clamp with int loop index
  // it('should handle int loop index in clamp', async () => {
  const mainId = 'main';
  const func: FunctionDef = {
    id: mainId,
    type: 'cpu',
    inputs: [],
    outputs: [{ id: 'out_val', type: 'float' }],
    nodes: [
      { id: 'start', op: 'literal', val: 0 },
      { id: 'end', op: 'literal', val: 10 },

      // Loop from 0 to 10
      { id: 'loop', op: 'flow_loop', start: 'start', end: 'end', exec_body: 'body_start', exec_completed: 'ret' },

      // Body: clamp(loop_index, 0.0, 5.0) -> if > 4.0 break/return?
      // Just return the clamped value of the last iteration (9) clamped to 5.0 => 5.0
      // But loop variable is int.

      { id: 'body_start', op: 'loop_index', loop: 'loop' },
      { id: 'min_val', op: 'literal', val: 0.0 },
      { id: 'max_val', op: 'literal', val: 5.0 },

      { id: 'clamped', op: 'math_clamp', val: 'body_start', min: 'min_val', max: 'max_val' },

      // We need to capture the value. Let's write to a var.
      { id: 'store', op: 'var_set', var: 'result', val: 'clamped', exec_in: 'loop', next: 'check_last' },

      // Let's just run to completion.
      { id: 'check_last', op: 'flow_branch', cond: 'false_val', exec_true: 'break_loop' } // dummy branch to keep loop valid?
    ],
    localVars: [
      { id: 'result', type: 'float', initialValue: 0.0 }
    ]
  };

  // Simplify: Just a function that calls clamp with int
  const clampFunc: FunctionDef = {
    id: mainId,
    type: 'cpu',
    inputs: [],
    outputs: [{ id: 'res', type: 'float' }],
    nodes: [
      { id: 'int_val', op: 'literal', val: 10 },
      { id: 'int_cast', op: 'static_cast_int', val: 'int_val' }, // Force int
      { id: 'min', op: 'literal', val: 0.0 },
      { id: 'max', op: 'literal', val: 5.0 },
      { id: 'clamped', op: 'math_clamp', val: 'int_cast', min: 'min', max: 'max' },
      { id: 'store_res', op: 'var_set', var: 'res', val: 'clamped' },
      { id: 'ret', op: 'func_return', val: 'res' }
    ],
    localVars: [{ id: 'res', type: 'float', initialValue: 0.0 }]
  };

  const doc: IRDocument = {
    version: '1.0.0',
    meta: { name: 'CoersionTest', author: 'Test' },
    entryPoint: mainId,
    functions: [clampFunc],
    resources: [],
    inputs: []
  };

  // JIT should return 5.0
  runFullGraphTest('Clamp Int Coersion', doc, async (ctx) => {
    const res = ctx.getVar('res');
    // console.log('Result:', res);
    if (res !== 5.0) throw new Error(`Expected 5.0, got ${res}`);
  }, backends);
  // }); // Removed closing brace for 'it'
});
