import { describe, expect } from 'vitest';
import { runFullGraphTest, runFullGraphErrorTest } from './test-runner';
import { IRDocument } from '../../ir/types';

describe('Conformance: Functions', () => {

  const bufferDef = {
    id: 'b_result',
    type: 'buffer',
    dataType: 'float',
    size: { mode: 'fixed', value: 1 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
  };

  runFullGraphTest('should execute Function Call and Return Value', {
    version: '3.0.0',
    meta: { name: 'Function Call' },
    entryPoint: 'fn_main',
    inputs: [],
    structs: [],
    resources: [bufferDef] as any,
    functions: [
      {
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'c1', op: 'call_func', func: 'fn_square', arg_x: 5 }, // Call square(5)
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1', exec_in: 'c1' } // Store result
        ]
      },
      {
        id: 'fn_square',
        type: 'cpu', // or shader, logic is same for interpreter
        inputs: [{ id: 'arg_x', type: 'float' }],
        outputs: [{ id: 'val', type: 'float' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'arg_x' },
          { id: 'sq', op: 'math_mul', a: 'in', b: 'in' },
          { id: 'ret', op: 'func_return', val: 'sq', exec_in: 'sq' }
        ]
      }
    ]
  }, (ctx) => {
    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(25);
  });

  runFullGraphTest('should execute Conditional Return (Flow Control)', {
    version: '3.0.0',
    meta: { name: 'Conditional Return' },
    entryPoint: 'fn_main',
    inputs: [],
    structs: [],
    resources: [bufferDef] as any,
    functions: [
      {
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'c1', op: 'call_func', func: 'fn_abs', arg: -10 },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_abs',
        type: 'cpu',
        inputs: [{ id: 'arg', type: 'float' }],
        outputs: [{ id: 'val', type: 'float' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'arg' },
          { id: 'zero', op: 'literal', val: 0 }, // Implicit 0
          { id: 'cond', op: 'math_gt', a: 'in', b: 0 },
          { id: 'branch', op: 'flow_branch', cond: 'cond', exec_true: 'ret_pos', exec_false: 'ret_neg' },
          // True Path: Return arg
          { id: 'ret_pos', op: 'func_return', val: 'in' },
          // False Path: Return -arg
          { id: 'neg', op: 'math_mul', a: 'in', b: -1 },
          { id: 'ret_neg', op: 'func_return', val: 'neg' }
        ]
      }
    ]
  }, (ctx) => {
    expect(ctx.getResource('b_result').data?.[0]).toBe(10);
  });

  runFullGraphErrorTest('should throw Error on Recursion', {
    version: '3.0.0',
    meta: { name: 'Recursion Test' },
    entryPoint: 'fn_main',
    inputs: [],
    structs: [],
    resources: [],
    functions: [
      {
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [{ id: 'c1', op: 'call_func', func: 'fn_A' }]
      },
      {
        id: 'fn_A',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [{ id: 'c2', op: 'call_func', func: 'fn_B' }]
      },
      {
        id: 'fn_B',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [{ id: 'c3', op: 'call_func', func: 'fn_A' }] // Recursion back to A
      }
    ]
  }, /Recursion detected|cyclic dependency/);

});
