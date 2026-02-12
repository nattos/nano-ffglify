import { describe, it } from 'vitest';
import { runFullGraphTest, availableBackends, cpuBackends } from './test-runner';
import { IRDocument, FunctionDef, DataType, TextureFormat } from '../../ir/types';

describe('20-coersion', () => {
  const backends = availableBackends;

  if (backends.length === 0) {
    it.skip('Skipping Coersion tests for current backend', () => { });
    return;
  }

  // Output buffer for verification
  const outBuffer: any = { id: 'out_buf', type: 'buffer', size: 1, dataType: 'float', persistence: { clearOnResize: false } };

  // Helper to add buffer store to function
  const withBufferStore = (f: FunctionDef, valNodeId: string): FunctionDef => {
    return {
      ...f,
      nodes: [
        ...f.nodes.filter(n => n.op !== 'func_return' && n.op !== 'var_set'), // Remove old return and var_set
        { id: 'store_' + valNodeId, op: 'buffer_store', buffer: 'out_buf', index: 0, value: valNodeId },
        { id: 'ret', op: 'func_return', val: valNodeId }
      ],
      outputs: [{ id: 'res', type: 'float' }], // Ensure output is defined for buffer store
      localVars: [] // Clear local vars if they were just for 'res'
    };
  };

  // Test case 1: Clamp with int loop index
  const mainId = 'clamp_test_main';
  const clampFunc: FunctionDef = {
    id: mainId,
    type: 'cpu',
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

  const clampFuncWithStore = withBufferStore(clampFunc, 'clamped');
  // Test case 1b: Clamp with int loop index (CPU version for CppMetal)
  const clampFuncCpu: FunctionDef = { ...withBufferStore(clampFunc, 'clamped'), id: 'clamp_cpu', type: 'cpu', outputs: [{ id: 'res', type: 'float' }] };

  const addFuncWithStore = withBufferStore(addFunc, 'sum');
  const sinFuncWithStore = withBufferStore(sinFunc, 'res_val');
  const mixFuncWithStore = withBufferStore(mixFunc, 'res_val');

  // Test case 5: Struct Array Coersion
  const structArrFunc: FunctionDef = {
    id: 'struct_arr_test',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'p1', op: 'struct_construct', type: 'Point', values: { x: 1.0, y: 2.0 } },
      { id: 'p2', op: 'struct_construct', type: 'Point', values: { x: 3.0, y: 4.0 } },
      { id: 'arr', op: 'array_construct', values: ['p1', 'p2'] },
      { id: 'disp', op: 'cmd_dispatch', func: 'shader_struct_arr', dispatch: [1, 1, 1], args: { data: 'arr' } }
    ]
  };

  const shaderStructArr: FunctionDef = {
    id: 'shader_struct_arr',
    type: 'shader',
    inputs: [{ id: 'data', type: 'array<Point, 2>' }],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'p', op: 'array_extract', array: 'data', index: 1 },
      { id: 'val', op: 'struct_extract', struct: 'p', field: 'y' },
      { id: 'store', op: 'buffer_store', buffer: 'out_buf', index: 0, value: 'val' }
    ]
  };

  // Test case 6: Float Array Literal (ambiguous 0.0)
  const floatArrFunc: FunctionDef = {
    id: 'float_arr_test',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'arr', op: 'array_construct', length: 2, fill: 0.0 }, // No type property
      { id: 'disp', op: 'cmd_dispatch', func: 'shader_float_arr', dispatch: [1, 1, 1], args: { data: 'arr' } }
    ]
  };

  const shaderFloatArr: FunctionDef = {
    id: 'shader_float_arr',
    type: 'shader',
    inputs: [{ id: 'data', type: 'array<float, 2>' }],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'v', op: 'array_extract', array: 'data', index: 0 },
      { id: 'store', op: 'buffer_store', buffer: 'out_buf', index: 0, value: 'v' }
    ]
  };

  const doc: IRDocument = {
    version: '1.0.0',
    meta: { name: 'CoersionTest', author: 'Test' },
    entryPoint: mainId,
    structs: [
      { id: 'Point', members: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }] }
    ],
    functions: [
      clampFuncWithStore, clampFuncCpu, addFuncWithStore, sinFuncWithStore, mixFuncWithStore,
    ],
    resources: [outBuffer],
    inputs: []
  };
  const cpuOnlyDoc: IRDocument = {
    version: '1.0.0',
    meta: { name: 'CoersionTest', author: 'Test' },
    entryPoint: mainId,
    structs: [
      { id: 'Point', members: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }] }
    ],
    functions: [
      structArrFunc, shaderStructArr, floatArrFunc, shaderFloatArr
    ],
    resources: [outBuffer],
    inputs: []
  };

  const verifyBuffer = (ctx: any, expected: number, tolerance = 0.0001) => {
    const buf = ctx.resources.get('out_buf');
    if (!buf || !buf.data || buf.data.length === 0) {
      try {
        return ctx.getVar('res');
      } catch {
        throw new Error('Output buffer empty and var not found');
      }
    }
    const val = buf.data[0];
    return val;
  };

  runFullGraphTest('Clamp Int Coersion', doc, async (ctx) => {
    const val = verifyBuffer(ctx, 5.0);
    if (Math.abs(val - 5.0) > 0.0001) throw new Error(`Clamp: Expected 5.0, got ${val}`);
  }, backends, 20000);

  runFullGraphTest('Clamp Int Coersion (CPU)', { ...doc, entryPoint: 'clamp_cpu' }, async (ctx) => {
    const val = verifyBuffer(ctx, 5.0);
    if (Math.abs(val - 5.0) > 0.0001) throw new Error(`Clamp CPU: Expected 5.0, got ${val}`);
  }, backends);

  runFullGraphTest('Add Mixed Coersion', { ...doc, entryPoint: 'add_test' }, async (ctx) => {
    const val = verifyBuffer(ctx, 5.5);
    if (Math.abs(val - 5.5) > 0.0001) throw new Error(`Add: Expected 5.5, got ${val}`);
  }, backends);

  runFullGraphTest('Sin Int Coersion', { ...doc, entryPoint: 'sin_test' }, async (ctx) => {
    const val = verifyBuffer(ctx, 0.0);
    if (Math.abs(val) > 0.0001) throw new Error(`Sin: Expected 0.0, got ${val}`);
  }, backends);

  runFullGraphTest('Mix Int Coersion', { ...doc, entryPoint: 'mix_test' }, async (ctx) => {
    const val = verifyBuffer(ctx, 5.0);
    if (Math.abs(val - 5.0) > 0.0001) throw new Error(`Mix: Expected 5.0, got ${val}`);
  }, backends);

  runFullGraphTest('Struct Array Coersion', { ...cpuOnlyDoc, entryPoint: 'struct_arr_test' }, async (ctx) => {
    const val = verifyBuffer(ctx, 4.0);
    if (Math.abs(val - 4.0) > 0.0001) throw new Error(`Struct Array: Expected 4.0, got ${val}`);
  }, cpuBackends);

  runFullGraphTest('Float Array Literal Coersion', { ...cpuOnlyDoc, entryPoint: 'float_arr_test' }, async (ctx) => {
    const val = verifyBuffer(ctx, 0.0);
    if (Math.abs(val) > 0.0001) throw new Error(`Float Array Literal: Expected 0.0, got ${val}`);
  }, cpuBackends);

});
