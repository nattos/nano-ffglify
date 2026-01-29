import { describe, it, expect } from 'vitest';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Structs and Arrays', () => {

  const bufferDef = {
    id: 'b_result',
    type: 'buffer',
    size: { mode: 'fixed', value: 1 },
    persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
  };

  it('should Construct and Extract Struct Fields', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Struct Test' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [
        { id: 'Particle', members: [{ name: 'pos', type: 'vec2' }, { name: 'vel', type: 'vec2' }] }
      ],
      resources: [bufferDef] as any,
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          // 1. Construct { pos: [1,2], vel: [0,0] }
          { id: 'v1', op: 'vec2', x: 1, y: 2 },
          { id: 'v2', op: 'vec2', x: 0, y: 0 },
          { id: 's1', op: 'struct_construct', type: 'Particle', pos: 'v1', vel: 'v2' },

          // 2. Extract 'pos'
          { id: 'pos', op: 'struct_extract', struct: 's1', field: 'pos' },

          // 3. Extract 'x' from pos (checking vec2)
          { id: 'x', op: 'vec_get_element', vec: 'pos', index: 0 },

          // 4. Store
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'x' }
        ],
        edges: [
          { from: 'v1', portOut: 'val', to: 's1', portIn: 'pos', type: 'data' },
          { from: 'v2', portOut: 'val', to: 's1', portIn: 'vel', type: 'data' },
          { from: 's1', portOut: 'val', to: 'pos', portIn: 'struct', type: 'data' },
          { from: 'pos', portOut: 'val', to: 'x', portIn: 'vec', type: 'data' },
          { from: 'x', portOut: 'val', to: 'store', portIn: 'value', type: 'data' },

          // Link Execution:
          // 'store' is the only Executable Node (Side Effect) here.
          // Pure nodes (v1, v2, s1, pos, x) are pulled lazily by 'store'.
          // 'store' has no incoming execution edges, so it is an Entry Point.
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(1);
  });

  it('should Construct and Manipulate Fixed-Size Arrays', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Array Test' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [bufferDef] as any,
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [{ id: 'arr', type: 'int', initialValue: [] }], // Type 'int' placeholder for array?
        nodes: [
          // 1. Create Array[3] filled with 0
          { id: 'mk_arr', op: 'array_construct', length: 3, fill: 0 },
          { id: 'set_var', op: 'var_set', var: 'arr', val: 'mk_arr' },

          // 2. Set arr[1] = 100
          { id: 'get_arr', op: 'var_get', var: 'arr' }, // Dependency for set
          { id: 'set_elem', op: 'array_set', array: 'get_arr', index: 1, value: 100 },

          // 3. Get arr[1]
          // Execution Order: set_var -> set_elem -> store.
          // 'store' demands 'extract', which demands 'read_arr'.
          // 'read_arr' (var_get) is evaluated when 'store' runs.
          // Since 'store' runs AFTER 'set_elem', 'read_arr' sees the modified array.

          { id: 'read_arr', op: 'var_get', var: 'arr' },
          { id: 'extract', op: 'array_extract', array: 'read_arr', index: 1 },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'extract' }
        ],
        edges: [
          // Data
          { from: 'mk_arr', portOut: 'val', to: 'set_var', portIn: 'val', type: 'data' },

          { from: 'get_arr', portOut: 'val', to: 'set_elem', portIn: 'array', type: 'data' },

          { from: 'read_arr', portOut: 'val', to: 'extract', portIn: 'array', type: 'data' },
          { from: 'extract', portOut: 'val', to: 'store', portIn: 'value', type: 'data' },

          // Execution Chain
          { from: 'set_var', portOut: 'exec_out', to: 'set_elem', portIn: 'exec_in', type: 'execution' },
          { from: 'set_elem', portOut: 'exec_out', to: 'store', portIn: 'exec_in', type: 'execution' }
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    const res = ctx.getResource('b_result');
    expect(res.data?.[0]).toBe(100);
  });

  it('should Construct and Extract Nested Structs', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Nested Struct Test' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [
        { id: 'Vec2', members: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }] },
        { id: 'Transform', members: [{ name: 'pos', type: 'Vec2' }, { name: 'scale', type: 'Vec2' }] }
      ],
      resources: [bufferDef] as any,
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          // 1. Create inner structs
          { id: 'v_pos', op: 'struct_construct', type: 'Vec2', x: 10, y: 20 },
          { id: 'v_scale', op: 'struct_construct', type: 'Vec2', x: 2, y: 2 },

          // 2. Create outer struct
          { id: 't1', op: 'struct_construct', type: 'Transform', pos: 'v_pos', scale: 'v_scale' },

          // 3. Extract Nested: t1.pos.y
          { id: 'pos', op: 'struct_extract', struct: 't1', field: 'pos' },
          { id: 'y', op: 'struct_extract', struct: 'pos', field: 'y' },

          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'y' }
        ],
        edges: [
          { from: 'v_pos', portOut: 'val', to: 't1', portIn: 'pos', type: 'data' },
          { from: 'v_scale', portOut: 'val', to: 't1', portIn: 'scale', type: 'data' },
          { from: 't1', portOut: 'val', to: 'pos', portIn: 'struct', type: 'data' },
          { from: 'pos', portOut: 'val', to: 'y', portIn: 'struct', type: 'data' },
          { from: 'y', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);
    exec.executeEntry();

    expect(ctx.getResource('b_result').data?.[0]).toBe(20);
  });

  it('should throw Error on Uninitialized Variable Access', () => {
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Uninit Var Test' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: [],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [{ id: 'v_uninit', type: 'float' }], // No initialValue
        nodes: [
          { id: 'get', op: 'var_get', var: 'v_uninit' },
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'get' }
        ],
        edges: [
          { from: 'get', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);

    // Expect Runtime Error when 'store' pulls 'get'
    expect(() => exec.executeEntry()).toThrow(/Runtime Error: Variable 'v_uninit' is not defined/);
  });

  it('should handle Buffer Default Values (Uninitialized Slots)', () => {
    // Reading from an unwritten buffer index returns 0 (scalar).
    // If we try to use it as a struct, it should fail.
    const ir: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Buffer Uninit Test' },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [{ id: 'S1', members: [{ name: 'x', type: 'float' }] }],
      resources: [bufferDef] as any,
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          // Load index 10 (never written)
          { id: 'load', op: 'buffer_load', buffer: 'b_result', index: 10 },
          // Try to extract field 'x' from it (expecting it to be a struct)
          { id: 'ex', op: 'struct_extract', struct: 'load', field: 'x' },
          // Store result to index 0 (execution trigger)
          { id: 'store', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'ex' }
        ],
        edges: [
          { from: 'load', portOut: 'val', to: 'ex', portIn: 'struct', type: 'data' },
          { from: 'ex', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
        ]
      }]
    };

    const ctx = new EvaluationContext(ir, new Map());
    const exec = new CpuExecutor(ctx);

    // Default load returns 0. struct_extract on 0 should fail.
    // Default load returns 0. struct_extract on 0 should fail.
    // However, strict bounds check now throws OOB on buffer_load first.
    expect(() => exec.executeEntry()).toThrow(/Runtime Error: buffer_load OOB/);
  });

});
