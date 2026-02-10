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
  const mainId = 'main';
  const clampFunc: FunctionDef = {
    id: mainId,
    type: 'shader',
    inputs: [],
    outputs: [],
    nodes: [
      { id: 'val', op: 'literal', val: 10 },
      { id: 'v_int', op: 'static_cast_int', val: 'val' }, // 10
      { id: 'min_v', op: 'literal', val: 0 },
      { id: 'max_v', op: 'literal', val: 5 },
      { id: 'clamped', op: 'math_clamp', val: 'v_int', min: 'min_v', max: 'max_v' }, // clamp(10, 0, 5) -> 5
      { id: 'res_store', op: 'var_set', var: 'res', val: 'clamped' },
      { id: 'ret', op: 'func_return', val: 'res' }
    ],
    localVars: [{ id: 'res', type: 'float', initialValue: 0.0 }]
  };

  // Test case 2: Polymorphic add (int + float) -> float
  const addFunc: FunctionDef = {
    id: 'add_test',
    type: 'cpu',
    inputs: [],
    outputs: [{ id: 'res', type: 'float' }],
    nodes: [
      { id: 'i_val', op: 'literal', val: 2 },
      { id: 'i_cast', op: 'static_cast_int', val: 'i_val' },
      { id: 'f_val', op: 'literal', val: 3.5 },
      { id: 'sum', op: 'math_add', a: 'i_cast', b: 'f_val' },
      { id: 'store', op: 'var_set', var: 'res', val: 'sum' },
      { id: 'ret', op: 'func_return', val: 'res' }
    ],
    localVars: [{ id: 'res', type: 'float', initialValue: 0.0 }]
  };

  // Test case 3: Strict float op (sin) with int input
  const sinFunc: FunctionDef = {
    id: 'sin_test',
    type: 'cpu',
    inputs: [],
    outputs: [{ id: 'res', type: 'float' }],
    nodes: [
      { id: 'i_val', op: 'literal', val: 0 },
      { id: 'i_cast', op: 'static_cast_int', val: 'i_val' },
      { id: 'res_val', op: 'math_sin', val: 'i_cast' }, // sin(0) = 0
      { id: 'store', op: 'var_set', var: 'res', val: 'res_val' },
      { id: 'ret', op: 'func_return', val: 'res' }
    ],
    localVars: [{ id: 'res', type: 'float', initialValue: 0.0 }]
  };

  // Test case 4: Mix with int inputs (should all coerce to float)
  const mixFunc: FunctionDef = {
    id: 'mix_test',
    type: 'cpu',
    inputs: [],
    outputs: [{ id: 'res', type: 'float' }],
    nodes: [
      { id: 'v0', op: 'literal', val: 0 },
      { id: 'v0_i', op: 'static_cast_int', val: 'v0' },
      { id: 'v1', op: 'literal', val: 10 },
      { id: 'v1_i', op: 'static_cast_int', val: 'v1' },
      { id: 't', op: 'literal', val: 0.5 },
      { id: 'res_val', op: 'math_mix', a: 'v0_i', b: 'v1_i', t: 't' }, // mix(0, 10, 0.5) = 5.0
      { id: 'store', op: 'var_set', var: 'res', val: 'res_val' },
      { id: 'ret', op: 'func_return', val: 'res' }
    ],
    localVars: [{ id: 'res', type: 'float', initialValue: 0.0 }]
  };

  const doc: IRDocument = {
    version: '1.0.0',
    meta: { name: 'CoersionTest', author: 'Test' },
    entryPoint: mainId,
    functions: [clampFunc, addFunc, sinFunc, mixFunc],
    resources: [], // Removed conflicting 'globals' resource
    inputs: []
  };

  runFullGraphTest('Clamp Int Coersion', doc, async (ctx) => {
    const res = ctx.getVar('res');
    if (res !== 5.0) throw new Error(`Clamp: Expected 5.0, got ${res}`);
  }, backends);

  runFullGraphTest('Add Mixed Coersion', { ...doc, entryPoint: 'add_test' }, async (ctx) => {
    const res = ctx.getVar('res');
    if (res !== 5.5) throw new Error(`Add: Expected 5.5, got ${res}`);
  }, backends);

  runFullGraphTest('Sin Int Coersion', { ...doc, entryPoint: 'sin_test' }, async (ctx) => {
    const res = ctx.getVar('res');
    if (Math.abs(res as number) > 0.0001) throw new Error(`Sin: Expected 0.0, got ${res}`);
  }, backends);

  runFullGraphTest('Mix Int Coersion', { ...doc, entryPoint: 'mix_test' }, async (ctx) => {
    const res = ctx.getVar('res');
    if (res !== 5.0) throw new Error(`Mix: Expected 5.0, got ${res}`);
  }, backends);

});
