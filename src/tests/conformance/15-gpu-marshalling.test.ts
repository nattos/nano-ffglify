import { describe, expect, it } from 'vitest';
import { runFullGraphTest, runFullGraphErrorTest, availableBackends, cpuBackends } from './test-runner';
import { IRDocument } from '../../ir/types';

// Marshalling is critical for backends that can dispatch compute jobs.
const backends = cpuBackends;

describe('Conformance: GPU Marshalling', () => {
  if (backends.length === 0) {
    it.skip('Skipping Marshalling tests for current backend', () => { });
  } else {

    // ----------------------------------------------------------------
    // Scalars
    // ----------------------------------------------------------------
    describe('Scalars', () => {
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: 'Scalar Marshalling' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 3 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'f_val', op: 'float', val: 3.14 },
              { id: 'i_val', op: 'int', val: 42 },
              { id: 'b_val', op: 'bool', val: true },
              { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1], args: { f: 'f_val', i: 'i_val', b: 'b_val' } }
            ]
          },
          {
            id: 'shader_main',
            type: 'shader',
            inputs: [
              { id: 'f', type: 'float' },
              { id: 'i', type: 'int' },
              { id: 'b', type: 'bool' }
            ],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 's1', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'f' },
              // Cast int/bool to float for storage
              { id: 'f_i', op: 'static_cast_float', val: 'i' },
              { id: 's2', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'f_i' },
              { id: 'f_b', op: 'static_cast_float', val: 'b' },
              { id: 's3', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'f_b' }
            ]
          }
        ]
      };

      runFullGraphTest('should marshal scalars (float, int, bool)', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data?.[0]).toBeCloseTo(3.14, 5);
        expect(res.data?.[1]).toBe(42);
        expect(res.data?.[2]).toBe(1);
      }, backends);
    });

    // ----------------------------------------------------------------
    // Vectors
    // ----------------------------------------------------------------
    describe('Vectors', () => {
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: 'Vector Marshalling' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 9 }, // 2 + 3 + 4
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'v2', op: 'float2', x: 1, y: 2 },
              { id: 'v3', op: 'float3', x: 3, y: 4, z: 5 },
              { id: 'v4', op: 'float4', x: 6, y: 7, z: 8, w: 9 },
              { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1], args: { v2: 'v2', v3: 'v3', v4: 'v4' } }
            ]
          },
          {
            id: 'shader_main',
            type: 'shader',
            inputs: [
              { id: 'v2', type: 'float2' },
              { id: 'v3', type: 'float3' },
              { id: 'v4', type: 'float4' }
            ],
            outputs: [],
            localVars: [],
            nodes: [
              // Store v2
              { id: 'v2x', op: 'vec_swizzle', vec: 'v2', channels: 'x' },
              { id: 'v2y', op: 'vec_swizzle', vec: 'v2', channels: 'y' },
              { id: 's1', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'v2x' },
              { id: 's2', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'v2y' },
              // Store v3
              { id: 'v3x', op: 'vec_swizzle', vec: 'v3', channels: 'x' },
              { id: 'v3y', op: 'vec_swizzle', vec: 'v3', channels: 'y' },
              { id: 'v3z', op: 'vec_swizzle', vec: 'v3', channels: 'z' },
              { id: 's3', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'v3x' },
              { id: 's4', op: 'buffer_store', buffer: 'b_res', index: 3, value: 'v3y' },
              { id: 's5', op: 'buffer_store', buffer: 'b_res', index: 4, value: 'v3z' },
              // Store v4
              { id: 'v4x', op: 'vec_swizzle', vec: 'v4', channels: 'x' },
              { id: 'v4y', op: 'vec_swizzle', vec: 'v4', channels: 'y' },
              { id: 'v4z', op: 'vec_swizzle', vec: 'v4', channels: 'z' },
              { id: 'v4w', op: 'vec_swizzle', vec: 'v4', channels: 'w' },
              { id: 's6', op: 'buffer_store', buffer: 'b_res', index: 5, value: 'v4x' },
              { id: 's7', op: 'buffer_store', buffer: 'b_res', index: 6, value: 'v4y' },
              { id: 's8', op: 'buffer_store', buffer: 'b_res', index: 7, value: 'v4z' },
              { id: 's9', op: 'buffer_store', buffer: 'b_res', index: 8, value: 'v4w' }
            ]
          }
        ]
      };

      runFullGraphTest('should marshal vectors (float2, float3, float4)', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      }, backends);
    });
    // ----------------------------------------------------------------
    // Matrices
    // ----------------------------------------------------------------
    describe('Matrices', () => {
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: 'Matrix Marshalling' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 25 }, // 9 + 16
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              // 3x3 diagonal
              { id: 'm3', op: 'float3x3', vals: [1, 0, 0, 0, 2, 0, 0, 0, 3] },
              // 4x4 diagonal
              { id: 'm4', op: 'float4x4', vals: [4, 0, 0, 0, 0, 5, 0, 0, 0, 0, 6, 0, 0, 0, 0, 7] },
              { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1], args: { m3: 'm3', m4: 'm4' } }
            ]
          },
          {
            id: 'shader_main',
            type: 'shader',
            inputs: [
              { id: 'm3', type: 'float3x3' },
              { id: 'm4', type: 'float4x4' }
            ],
            outputs: [],
            localVars: [],
            nodes: [
              // Store m3
              { id: 'm3_0', op: 'array_extract', array: 'm3', index: 0 },
              { id: 'm3_4', op: 'array_extract', array: 'm3', index: 4 },
              { id: 'm3_8', op: 'array_extract', array: 'm3', index: 8 },
              { id: 's0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'm3_0' },
              { id: 's4', op: 'buffer_store', buffer: 'b_res', index: 4, value: 'm3_4' },
              { id: 's8', op: 'buffer_store', buffer: 'b_res', index: 8, value: 'm3_8' },
              // Store m4
              { id: 'm4_0', op: 'array_extract', array: 'm4', index: 0 },
              { id: 'm4_5', op: 'array_extract', array: 'm4', index: 5 },
              { id: 'm4_10', op: 'array_extract', array: 'm4', index: 10 },
              { id: 'm4_15', op: 'array_extract', array: 'm4', index: 15 },
              { id: 's0_m4', op: 'buffer_store', buffer: 'b_res', index: 9, value: 'm4_0' },
              { id: 's5_m4', op: 'buffer_store', buffer: 'b_res', index: 14, value: 'm4_5' },
              { id: 's10_m4', op: 'buffer_store', buffer: 'b_res', index: 19, value: 'm4_10' },
              { id: 's15_m4', op: 'buffer_store', buffer: 'b_res', index: 24, value: 'm4_15' }
            ]
          }
        ]
      };

      runFullGraphTest('should marshal matrices (float3x3, float4x4)', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        // Indices 0, 4, 8 for m3
        expect(res.data?.[0]).toBe(1);
        expect(res.data?.[4]).toBe(2);
        expect(res.data?.[8]).toBe(3);
        // Indices 9, 14, 19, 24 for m4 diagonal (matching 0, 5, 10, 15 offset)
        expect(res.data?.[9]).toBe(4);
        expect(res.data?.[14]).toBe(5);
        expect(res.data?.[19]).toBe(6);
        expect(res.data?.[24]).toBe(7);
      }, backends);
    });


    // ----------------------------------------------------------------
    // Structs
    // ----------------------------------------------------------------
    describe('Structs', () => {
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: 'Struct Marshalling' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 3 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [
          {
            id: 'Simple',
            members: [
              { name: 'a', type: 'float' },
              { name: 'b', type: 'float2' }
            ]
          }
        ],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'v2', op: 'float2', x: 20, y: 30 },
              { id: 's', op: 'struct_construct', type: 'Simple', a: 10, b: 'v2' },
              { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1], args: { data: 's' } }
            ]
          },
          {
            id: 'shader_main',
            type: 'shader',
            inputs: [{ id: 'data', type: 'Simple' }],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'a', op: 'struct_extract', struct: 'data', field: 'a' },
              { id: 'b', op: 'struct_extract', struct: 'data', field: 'b' },
              { id: 'bx', op: 'vec_swizzle', vec: 'b', channels: 'x' },
              { id: 'by', op: 'vec_swizzle', vec: 'b', channels: 'y' },
              { id: 's1', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'a' },
              { id: 's2', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'bx' },
              { id: 's3', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'by' }
            ]
          }
        ]
      };

      runFullGraphTest('should marshal simple structs', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data).toEqual([10, 20, 30]);
      }, backends);
    });

    // ----------------------------------------------------------------
    // Fixed Arrays
    // ----------------------------------------------------------------
    describe('Fixed Arrays', () => {
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: 'Fixed Array Marshalling' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 3 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'arr', op: 'array_construct', length: 3, fill: 7.0 },
              { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1], args: { data: 'arr' } }
            ]
          },
          {
            id: 'shader_main',
            type: 'shader',
            inputs: [{ id: 'data', type: 'array<float, 3>' }],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'e0', op: 'array_extract', array: 'data', index: 0 },
              { id: 'e1', op: 'array_extract', array: 'data', index: 1 },
              { id: 'e2', op: 'array_extract', array: 'data', index: 2 },
              { id: 's0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'e0' },
              { id: 's1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'e1' },
              { id: 's2', op: 'buffer_store', buffer: 'b_res', index: 2, value: 'e2' }
            ]
          }
        ]
      };

      runFullGraphTest('should marshal fixed arrays', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data).toEqual([7, 7, 7]);
      }, backends);
    });

    // ----------------------------------------------------------------
    // Dynamic Arrays
    // ----------------------------------------------------------------
    describe('Dynamic Arrays', () => {
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: 'Dynamic Array Marshalling' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 4 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'arr', op: 'array_construct', length: 4, fill: 9.0 },
              { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1], args: { data: 'arr' } }
            ]
          },
          {
            id: 'shader_main',
            type: 'shader',
            // Dynamic array input (no fixed size)
            inputs: [{ id: 'data', type: 'float[]' }],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'len', op: 'array_length', array: 'data' },
              { id: 'e0', op: 'array_extract', array: 'data', index: 0 },
              { id: 's0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'e0' },
              // Store length as float at index 1
              { id: 'flen', op: 'static_cast_float', val: 'len' },
              { id: 's1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'flen' }
            ]
          }
        ]
      };

      runFullGraphTest('should marshal dynamic arrays (runtime length)', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data?.[0]).toBe(9);
        expect(res.data?.[1]).toBe(4);
      }, backends);
    });

    // ----------------------------------------------------------------
    // Struct Arrays
    // ----------------------------------------------------------------
    describe('Struct Arrays', () => {
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: 'Struct Array Marshalling' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          {
            id: 'b_res',
            type: 'buffer',
            dataType: 'float',
            size: { mode: 'fixed', value: 2 },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: true }
          }
        ],
        structs: [
          {
            id: 'Point',
            members: [{ name: 'val', type: 'float' }]
          }
        ],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'p1', op: 'struct_construct', type: 'Point', val: 123 },
              { id: 'p2', op: 'struct_construct', type: 'Point', val: 456 },
              { id: 'arr', op: 'array_construct', length: 2, fill: 'p1', next: 'set' },
              { id: 'set', op: 'array_set', array: 'arr', index: 1, value: 'p2', exec_out: 'disp' },
              { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1], args: { points: 'arr' } }
            ]
          },
          {
            id: 'shader_main',
            type: 'shader',
            inputs: [{ id: 'points', type: 'Point[]' }],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'e0', op: 'array_extract', array: 'points', index: 0 },
              { id: 'e1', op: 'array_extract', array: 'points', index: 1 },
              { id: 'v0', op: 'struct_extract', struct: 'e0', field: 'val' },
              { id: 'v1', op: 'struct_extract', struct: 'e1', field: 'val' },
              { id: 's0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'v0' },
              { id: 's1', op: 'buffer_store', buffer: 'b_res', index: 1, value: 'v1' }
            ]
          }
        ]
      };

      runFullGraphTest('should marshal dynamic arrays of structs', ir, (ctx) => {
        const res = ctx.getResource('b_res');
        expect(res.data).toEqual([123, 456]);
      }, backends);
    });

    // ----------------------------------------------------------------
    // Errors: Strings
    // ----------------------------------------------------------------
    describe('Errors: Strings', () => {
      const ir: IRDocument = {
        version: '3.0.0',
        meta: { name: 'String Error' },
        entryPoint: 'main',
        inputs: [],
        resources: [],
        structs: [],
        functions: [
          {
            id: 'main',
            type: 'cpu',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'str', op: 'string', val: 'hello' },
              { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1], args: { msg: 'str' } }
            ]
          },
          {
            id: 'shader_main',
            type: 'shader',
            inputs: [{ id: 'msg', type: 'string' }],
            outputs: [],
            localVars: [],
            nodes: []
          }
        ]
      };

      // We expect this to fail during validation or execution in backends
      // Shader backends doesn't support strings.
      runFullGraphErrorTest('should error on string marshalling to shader', ir, /string/i, backends);
    });
  }
});
