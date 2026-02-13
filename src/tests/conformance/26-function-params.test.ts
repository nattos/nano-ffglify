import { describe, expect } from 'vitest';
import { runFullGraphTest, cpuBackends } from './test-runner';
import { IRDocument } from '../../ir/types';

describe('Conformance: Function Parameter & Return Types', () => {

  const bufferDef = {
    id: 'b_result',
    type: 'buffer',
    dataType: 'float',
    size: { mode: 'fixed', value: 4 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
  };

  // A. Scalar Parameters

  runFullGraphTest('should pass int param and return int', {
    version: '1.0.0',
    meta: { name: 'Int Param' },
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
          { id: 'c1', op: 'call_func', func: 'fn_double_int', args: { x: 7 } },
          { id: 'c1f', op: 'static_cast_float', val: 'c1' },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1f', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_double_int',
        type: 'cpu',
        inputs: [{ id: 'x', type: 'int' }],
        outputs: [{ id: 'val', type: 'int' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'x' },
          { id: 'two', op: 'int', val: 2 },
          { id: 'result', op: 'math_mul', a: 'in', b: 'two' },
          { id: 'ret', op: 'func_return', val: 'result', exec_in: 'result' }
        ]
      }
    ]
  }, (ctx) => {
    expect(ctx.getResource('b_result').data?.[0]).toBe(14);
  });

  // B. Vector Parameters

  runFullGraphTest('should pass float3 and return component', {
    version: '1.0.0',
    meta: { name: 'Float3 Param' },
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
          { id: 'v', op: 'float3', x: 10, y: 20, z: 30 },
          { id: 'c1', op: 'call_func', func: 'fn_get_y', args: { v: 'v' } },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_get_y',
        type: 'cpu',
        inputs: [{ id: 'v', type: 'float3' }],
        outputs: [{ id: 'val', type: 'float' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'v' },
          { id: 'y', op: 'vec_get_element', vec: 'in', index: 1 },
          { id: 'ret', op: 'func_return', val: 'y', exec_in: 'y' }
        ]
      }
    ]
  }, (ctx) => {
    expect(ctx.getResource('b_result').data?.[0]).toBe(20);
  });

  runFullGraphTest('should pass float4 and return float4', {
    version: '1.0.0',
    meta: { name: 'Float4 Param Return' },
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
          { id: 'v', op: 'float4', x: 1, y: 2, z: 3, w: 4 },
          { id: 'c1', op: 'call_func', func: 'fn_scale', args: { v: 'v' } },
          { id: 'ex', op: 'vec_get_element', vec: 'c1', index: 2 },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'ex', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_scale',
        type: 'cpu',
        inputs: [{ id: 'v', type: 'float4' }],
        outputs: [{ id: 'val', type: 'float4' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'v' },
          { id: 'two', op: 'float4', x: 2, y: 2, z: 2, w: 2 },
          { id: 'result', op: 'math_mul', a: 'in', b: 'two' },
          { id: 'ret', op: 'func_return', val: 'result', exec_in: 'result' }
        ]
      }
    ]
  }, (ctx) => {
    // z component: 3 * 2 = 6
    expect(ctx.getResource('b_result').data?.[0]).toBe(6);
  });

  runFullGraphTest('should pass int3 and return int2 swizzle', {
    version: '1.0.0',
    meta: { name: 'Int3 to Int2 Swizzle' },
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
          { id: 'v', op: 'int3', x: 10, y: 20, z: 30 },
          { id: 'c1', op: 'call_func', func: 'fn_swizzle_xz', args: { v: 'v' } },
          { id: 'ex0', op: 'vec_get_element', vec: 'c1', index: 0 },
          { id: 'ex1', op: 'vec_get_element', vec: 'c1', index: 1 },
          { id: 'ex0f', op: 'static_cast_float', val: 'ex0' },
          { id: 'ex1f', op: 'static_cast_float', val: 'ex1' },
          { id: 'store0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'ex0f', exec_in: 'c1' },
          { id: 'store1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'ex1f', exec_in: 'store0' }
        ]
      },
      {
        id: 'fn_swizzle_xz',
        type: 'cpu',
        inputs: [{ id: 'v', type: 'int3' }],
        outputs: [{ id: 'val', type: 'int2' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'v' },
          { id: 'sw', op: 'vec_swizzle', vec: 'in', channels: 'xz' },
          { id: 'ret', op: 'func_return', val: 'sw', exec_in: 'sw' }
        ]
      }
    ]
  }, (ctx) => {
    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(10);
    expect(res.data?.[1]).toBe(30);
  });

  // C. Struct Parameters

  runFullGraphTest('should pass struct and extract field', {
    version: '1.0.0',
    meta: { name: 'Struct Param Extract' },
    entryPoint: 'fn_main',
    inputs: [],
    structs: [
      { id: 'Point', members: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }] }
    ],
    resources: [bufferDef] as any,
    functions: [
      {
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'pt', op: 'struct_construct', type: 'Point', values: { x: 42, y: 99 } },
          { id: 'c1', op: 'call_func', func: 'fn_get_y', args: { p: 'pt' } },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_get_y',
        type: 'cpu',
        inputs: [{ id: 'p', type: 'Point' }],
        outputs: [{ id: 'val', type: 'float' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'p' },
          { id: 'y', op: 'struct_extract', struct: 'in', field: 'y' },
          { id: 'ret', op: 'func_return', val: 'y', exec_in: 'y' }
        ]
      }
    ]
  }, (ctx) => {
    expect(ctx.getResource('b_result').data?.[0]).toBe(99);
  });

  runFullGraphTest('should pass struct with vector field', {
    version: '1.0.0',
    meta: { name: 'Struct Vec Field Param' },
    entryPoint: 'fn_main',
    inputs: [],
    structs: [
      { id: 'Particle', members: [{ name: 'pos', type: 'float2' }, { name: 'vel', type: 'float2' }] }
    ],
    resources: [bufferDef] as any,
    functions: [
      {
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'p', op: 'float2', x: 5, y: 10 },
          { id: 'vel', op: 'float2', x: 1, y: -1 },
          { id: 'pt', op: 'struct_construct', type: 'Particle', values: { pos: 'p', vel: 'vel' } },
          { id: 'c1', op: 'call_func', func: 'fn_get_pos_x', args: { particle: 'pt' } },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_get_pos_x',
        type: 'cpu',
        inputs: [{ id: 'particle', type: 'Particle' }],
        outputs: [{ id: 'val', type: 'float' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'particle' },
          { id: 'pos', op: 'struct_extract', struct: 'in', field: 'pos' },
          { id: 'x', op: 'vec_get_element', vec: 'pos', index: 0 },
          { id: 'ret', op: 'func_return', val: 'x', exec_in: 'x' }
        ]
      }
    ]
  }, (ctx) => {
    expect(ctx.getResource('b_result').data?.[0]).toBe(5);
  });

  runFullGraphTest('should return struct from function', {
    version: '1.0.0',
    meta: { name: 'Struct Return' },
    entryPoint: 'fn_main',
    inputs: [],
    structs: [
      { id: 'Pair', members: [{ name: 'a', type: 'float' }, { name: 'b', type: 'float' }] }
    ],
    resources: [bufferDef] as any,
    functions: [
      {
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'c1', op: 'call_func', func: 'fn_make_pair', args: { x: 3, y: 7 } },
          { id: 'fb', op: 'struct_extract', struct: 'c1', field: 'b' },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'fb', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_make_pair',
        type: 'cpu',
        inputs: [{ id: 'x', type: 'float' }, { id: 'y', type: 'float' }],
        outputs: [{ id: 'val', type: 'Pair' }],
        localVars: [],
        nodes: [
          { id: 'ix', op: 'var_get', var: 'x' },
          { id: 'iy', op: 'var_get', var: 'y' },
          { id: 'pair', op: 'struct_construct', type: 'Pair', values: { a: 'ix', b: 'iy' } },
          { id: 'ret', op: 'func_return', val: 'pair', exec_in: 'pair' }
        ]
      }
    ]
  }, (ctx) => {
    expect(ctx.getResource('b_result').data?.[0]).toBe(7);
  });

  // D. Fixed-Size Array Parameters

  runFullGraphTest('should pass array<float, 3> and extract element', {
    version: '1.0.0',
    meta: { name: 'Array Param Extract' },
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
          { id: 'arr', op: 'array_construct', values: [10, 20, 30] },
          { id: 'c1', op: 'call_func', func: 'fn_get_elem', args: { arr: 'arr' } },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_get_elem',
        type: 'cpu',
        inputs: [{ id: 'arr', type: 'array<float, 3>' }],
        outputs: [{ id: 'val', type: 'float' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'arr' },
          { id: 'elem', op: 'array_extract', array: 'in', index: 1 },
          { id: 'ret', op: 'func_return', val: 'elem', exec_in: 'elem' }
        ]
      }
    ]
  }, (ctx) => {
    expect(ctx.getResource('b_result').data?.[0]).toBe(20);
  });

  // E. Matrix Parameters

  // Matrix param test: CPU backends only (GPU/Metal have pre-existing limitations
  // with matrix type detection in non-entry helper functions)
  runFullGraphTest('should pass float3x3 param and extract element', {
    version: '1.0.0',
    meta: { name: 'Matrix Param' },
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
          // Diagonal matrix: [5,0,0, 0,5,0, 0,0,5]
          { id: 'mat', op: 'float3x3', vals: [5, 0, 0, 0, 5, 0, 0, 0, 5] },
          { id: 'c1', op: 'call_func', func: 'fn_get_diag', args: { m: 'mat' } },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_get_diag',
        type: 'cpu',
        inputs: [{ id: 'm', type: 'float3x3' }],
        outputs: [{ id: 'val', type: 'float' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'm' },
          // Flat index 4 = middle diagonal (col1[1]) = 5.0
          { id: 'elem', op: 'vec_get_element', vec: 'in', index: 4 },
          { id: 'ret', op: 'func_return', val: 'elem', exec_in: 'elem' }
        ]
      }
    ]
  }, (ctx) => {
    expect(ctx.getResource('b_result').data?.[0]).toBe(5);
  }, cpuBackends);

  // F. Multiple Mixed Parameters

  runFullGraphTest('should pass mixed params (float, float3, int)', {
    version: '1.0.0',
    meta: { name: 'Mixed Params' },
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
          { id: 'v', op: 'float3', x: 1, y: 2, z: 3 },
          { id: 'c1', op: 'call_func', func: 'fn_combine', args: { scale: 10, vec: 'v', idx: 2 } },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_combine',
        type: 'cpu',
        inputs: [
          { id: 'scale', type: 'float' },
          { id: 'vec', type: 'float3' },
          { id: 'idx', type: 'int' }
        ],
        outputs: [{ id: 'val', type: 'float' }],
        localVars: [],
        nodes: [
          { id: 'iv', op: 'var_get', var: 'vec' },
          { id: 'ii', op: 'var_get', var: 'idx' },
          { id: 'is', op: 'var_get', var: 'scale' },
          { id: 'elem', op: 'vec_get_element', vec: 'iv', index: 'ii' },
          { id: 'result', op: 'math_mul', a: 'elem', b: 'is' },
          { id: 'ret', op: 'func_return', val: 'result', exec_in: 'result' }
        ]
      }
    ]
  }, (ctx) => {
    // vec[2] * scale = 3 * 10 = 30
    expect(ctx.getResource('b_result').data?.[0]).toBe(30);
  });

  // G. Nested Calls with Vector Types

  runFullGraphTest('should chain function calls with vector types', {
    version: '1.0.0',
    meta: { name: 'Nested Vector Calls' },
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
          { id: 'v', op: 'float3', x: 1, y: 2, z: 3 },
          { id: 'c1', op: 'call_func', func: 'fn_outer', args: { v: 'v' } },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'c1', exec_in: 'c1' }
        ]
      },
      {
        id: 'fn_outer',
        type: 'cpu',
        inputs: [{ id: 'v', type: 'float3' }],
        outputs: [{ id: 'val', type: 'float' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'v' },
          // Call inner to double the vector, then sum
          { id: 'doubled', op: 'call_func', func: 'fn_double_vec', args: { v: 'in' } },
          // Extract y component from doubled: 2*2=4
          { id: 'y', op: 'vec_get_element', vec: 'doubled', index: 1 },
          { id: 'ret', op: 'func_return', val: 'y', exec_in: 'doubled' }
        ]
      },
      {
        id: 'fn_double_vec',
        type: 'cpu',
        inputs: [{ id: 'v', type: 'float3' }],
        outputs: [{ id: 'val', type: 'float3' }],
        localVars: [],
        nodes: [
          { id: 'in', op: 'var_get', var: 'v' },
          { id: 'two', op: 'float3', x: 2, y: 2, z: 2 },
          { id: 'result', op: 'math_mul', a: 'in', b: 'two' },
          { id: 'ret', op: 'func_return', val: 'result', exec_in: 'result' }
        ]
      }
    ]
  }, (ctx) => {
    // fn_double_vec doubles [1,2,3] to [2,4,6], fn_outer extracts y=4
    expect(ctx.getResource('b_result').data?.[0]).toBe(4);
  });

});
