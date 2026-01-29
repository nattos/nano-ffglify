import { describe, expect } from 'vitest';
import { runParametricTest, runGraphErrorTest } from './test-runner';

describe('Conformance: Structs and Arrays', () => {

  const bufferDef = {
    id: 'b_result',
    type: 'buffer',
    size: { mode: 'fixed', value: 1 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
  };

  runParametricTest('should Construct and Extract Struct Fields', [
    // 1. Construct { pos: [1,2], vel: [0,0] }
    { id: 'v1', op: 'float2', x: 1, y: 2 },
    { id: 'v2', op: 'float2', x: 0, y: 0 },
    { id: 's1', op: 'struct_construct', type: 'Particle', pos: 'v1', vel: 'v2' },

    // 2. Extract 'pos'
    { id: 'pos', op: 'struct_extract', struct: 's1', field: 'pos' },

    // 3. Extract 'x' from pos (checking float2)
    { id: 'x', op: 'vec_get_element', vec: 'pos', index: 0 },

    // 4. Store
    { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'x' }
  ], (ctx) => {
    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(1);
  }, [bufferDef], [
    { from: 'v1', portOut: 'val', to: 's1', portIn: 'pos', type: 'data' },
    { from: 'v2', portOut: 'val', to: 's1', portIn: 'vel', type: 'data' },
    { from: 's1', portOut: 'val', to: 'pos', portIn: 'struct', type: 'data' },
    { from: 'pos', portOut: 'val', to: 'x', portIn: 'vec', type: 'data' },
    { from: 'x', portOut: 'val', to: 'store', portIn: 'value', type: 'data' },
  ], undefined, [
    { id: 'Particle', members: [{ name: 'pos', type: 'float2' }, { name: 'vel', type: 'float2' }] }
  ]);

  runParametricTest('should Construct and Manipulate Fixed-Size Arrays', [
    // 1. Create Array[3] filled with 0
    { id: 'mk_arr', op: 'array_construct', length: 3, fill: 0 },
    { id: 'set_var', op: 'var_set', var: 'arr', val: 'mk_arr' },

    // 2. Set arr[1] = 100
    { id: 'get_arr', op: 'var_get', var: 'arr' }, // Dependency for set
    { id: 'set_elem', op: 'array_set', array: 'get_arr', index: 1, value: 100 },

    // 3. Get arr[1]
    { id: 'read_arr', op: 'var_get', var: 'arr' },
    { id: 'extract', op: 'array_extract', array: 'read_arr', index: 1 },
    { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'extract' }
  ], (ctx) => {
    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(100);
  }, [bufferDef], [
    { from: 'mk_arr', portOut: 'val', to: 'set_var', portIn: 'val', type: 'data' },
    { from: 'get_arr', portOut: 'val', to: 'set_elem', portIn: 'array', type: 'data' },
    { from: 'read_arr', portOut: 'val', to: 'extract', portIn: 'array', type: 'data' },
    { from: 'extract', portOut: 'val', to: 'store', portIn: 'value', type: 'data' },
    { from: 'set_var', portOut: 'exec_out', to: 'set_elem', portIn: 'exec_in', type: 'execution' },
    { from: 'set_elem', portOut: 'exec_out', to: 'store', portIn: 'exec_in', type: 'execution' }
  ], [{ id: 'arr', type: 'int', initialValue: [] }]);

  runParametricTest('should Construct and Extract Nested Structs', [
    // 1. Create inner structs
    { id: 'v_pos', op: 'struct_construct', type: 'float2', x: 10, y: 20 },
    { id: 'v_scale', op: 'struct_construct', type: 'float2', x: 2, y: 2 },

    // 2. Create outer struct
    { id: 't1', op: 'struct_construct', type: 'Transform', pos: 'v_pos', scale: 'v_scale' },

    // 3. Extract Nested: t1.pos.y
    { id: 'pos', op: 'struct_extract', struct: 't1', field: 'pos' },
    { id: 'y', op: 'struct_extract', struct: 'pos', field: 'y' },

    { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'y' }
  ], (ctx) => {
    expect(ctx.getResource('b_result').data?.[0]).toBe(20);
  }, [bufferDef], [
    { from: 'v_pos', portOut: 'val', to: 't1', portIn: 'pos', type: 'data' },
    { from: 'v_scale', portOut: 'val', to: 't1', portIn: 'scale', type: 'data' },
    { from: 't1', portOut: 'val', to: 'pos', portIn: 'struct', type: 'data' },
    { from: 'pos', portOut: 'val', to: 'y', portIn: 'struct', type: 'data' },
    { from: 'y', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
  ], undefined, [
    { id: 'float2', members: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }] },
    { id: 'Transform', members: [{ name: 'pos', type: 'float2' }, { name: 'scale', type: 'float2' }] }
  ]);

  runGraphErrorTest('should throw Error on Uninitialized Variable Access', [
    { id: 'get', op: 'var_get', var: 'v_uninit' },
    { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'get' }
  ], /Runtime Error: Variable 'v_uninit' is not defined/, [bufferDef], [], []);

  runGraphErrorTest('should handle Buffer Default Values (Uninitialized Slots)', [
    // Load index 10 (never written)
    { id: 'load', op: 'buffer_load', buffer: 'b_result', index: 10 },
    // Try to extract field 'x' from it (expecting it to be a struct)
    { id: 'ex', op: 'struct_extract', struct: 'load', field: 'x' },
    { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'ex' }
  ], /Runtime Error: buffer_load OOB/, [bufferDef], [
    { id: 'S1', members: [{ name: 'x', type: 'float' }] }
  ]);
});
