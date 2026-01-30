import { describe, it } from 'vitest';
import { runFullGraphTest, availableBackends } from './test-runner';
import { IRDocument, FunctionDef, BuiltinOp, DataType, TextureFormat, ResourceDef } from '../../ir/types';

describe('17-render-pipeline', () => {
  // Only run on WebGPU backend for now (Interpreter Rasterizer not implemented)
  const backends = availableBackends.filter(b => b.name === 'WebGPU');

  // IR Definition
  // Func Main: cmd_draw -> VS, FS
  // Func VS: returns VertexOutput { pos: vec4 }
  // Func FS: returns vec4(1, 0, 0, 1)

  const vsId = 'vs_main';
  const fsId = 'fs_main';
  const mainId = 'cpu_main';
  const targetId = 't_output';

  const vsFunc: FunctionDef = {
    id: vsId,
    type: 'shader',
    inputs: [
      { id: 'v_idx', type: 'int', builtin: 'vertex_index' }
    ],
    outputs: [
      { id: 'pos', type: 'float4' } // Structure inferred? WgslGenerator needs struct def.
    ],
    nodes: [
      { id: 'idx', op: 'var_get', var: 'v_idx' },
      { id: 'pos_0', op: 'literal', val: '0.0' },
      { id: 'pos_1', op: 'literal', val: '0.5' },
      // Hardcode triangle positions based on index?
      // Index 0: (0, 0.5)
      // Index 1: (0.5, -0.5)
      // Index 2: (-0.5, -0.5)
      // Simplified: Just one triangle covering center
      // Let's use a switch/if chain or array lookup?
      // Array lookup is easier if array_extract works.
      // Positions Flat: [0, 0.5, 0.5, -0.5, -0.5, -0.5]
      { id: 'positions', op: 'array_construct', values: [0.0, 0.5, 0.5, -0.5, -0.5, -0.5] },
      { id: 'idx_2', op: 'math_mul', a: 'idx', b: 2 },
      { id: 'x', op: 'array_extract', array: 'positions', index: 'idx_2' },
      { id: 'idx_2_1', op: 'math_add', a: 'idx_2', b: 1 },
      { id: 'y', op: 'array_extract', array: 'positions', index: 'idx_2_1' },

      { id: 'pos', op: 'float4', x: 'x', y: 'y', z: 0.0, w: 1.0 },

      // Struct Construction for Return?
      // If VS returns 'pos' directly, WgslGenerator wraps it if outputs > 0?
      // WgslGenerator: "must return a struct with @builtin(position)"
      // If we return 'float4', generator infers it as Position?
      // WgslGenerator logic check: "outputs[0]?.type || 'vec4<f32'".
      // But the function signature return type must match.
      // And generated main returns "VertexOutput".
      // SO we MUST Define a struct in IR.
      { id: 'ret_struct', op: 'struct_construct', type: 'VertexOutput', pos: 'pos' },
      { id: 'ret', op: 'func_return', value: 'ret_struct' }
    ],
    edges: [
      { from: 'idx', to: 'idx_2', portIn: 'a', portOut: 'val', type: 'data' },
      { from: 'positions', to: 'x', portIn: 'array', portOut: 'val', type: 'data' },
      { from: 'idx_2', to: 'x', portIn: 'index', portOut: 'val', type: 'data' },
      { from: 'positions', to: 'y', portIn: 'array', portOut: 'val', type: 'data' },
      { from: 'idx_2', to: 'idx_2_1', portIn: 'a', portOut: 'val', type: 'data' },
      { from: 'idx_2_1', to: 'y', portIn: 'index', portOut: 'val', type: 'data' },
      { from: 'x', to: 'pos', portIn: 'x', portOut: 'val', type: 'data' },
      { from: 'y', to: 'pos', portIn: 'y', portOut: 'val', type: 'data' },
      { from: 'pos', to: 'ret_struct', portIn: 'pos', portOut: 'val', type: 'data' },
      { from: 'ret_struct', to: 'ret', portIn: 'value', portOut: 'val', type: 'data' },

      // Execution
      // Start -> ret
    ],
    localVars: []
  };

  // Connect execution: Entry -> ret
  // Wait, IR functions don't have explicit entry node unless it's an execution root.
  // 'func_return' is an executable node.
  // We need an edge to 'ret' Exec In.
  // From where? No entry node.
  // Usually 'func_return' is connected to previous ops.
  // But here we have only data ops.
  // We can add a 'flow_start' or just implicit entry?
  // WgslGenerator finds "Entry Nodes" (logic nodes with no incoming execution edge).
  // 'func_return' is executable. Has no incoming exec edge. So it is entry.

  // Define Struct "VertexOutput"
  const vertexOutputStruct = {
    id: 'VertexOutput',
    members: [
      { name: 'pos', type: 'float4' as DataType, builtin: 'position' as const }
    ]
  };
  // Update VS func outputs to type 'VertexOutput'
  vsFunc.outputs[0].type = 'VertexOutput';

  const fsFunc: FunctionDef = {
    id: fsId,
    type: 'shader',
    inputs: [
      { id: 'in', type: 'VertexOutput' } // Must match VS output
    ],
    outputs: [
      { id: 'color', type: 'float4' }
    ],
    nodes: [
      { id: 'red', op: 'literal', val: '1.0' },
      { id: 'col', op: 'float4', x: 'red', y: 0, z: 0, w: 1 },
      { id: 'ret', op: 'func_return', value: 'col' }
    ],
    edges: [
      { from: 'red', to: 'col', portIn: 'x', portOut: 'val', type: 'data' },
      { from: 'col', to: 'ret', portIn: 'value', portOut: 'val', type: 'data' }
    ],
    localVars: []
  };

  const mainFunc: FunctionDef = {
    id: mainId,
    type: 'cpu',
    inputs: [],
    outputs: [],
    nodes: [
      // Draw 3 vertices
      {
        id: 'draw_cmd',
        op: 'cmd_draw',
        target: targetId,
        vertex: vsId,
        fragment: fsId,
        count: 3,
        pipeline: { topology: 'triangle-list' }
      }
    ],
    edges: [],
    localVars: []
  };

  const doc: IRDocument = {
    meta: { name: 'RenderTest', author: 'Test', version: '1' },
    entryPoint: mainId,
    functions: [vsFunc, fsFunc, mainFunc],
    resources: [
      { id: targetId, type: 'texture2d', size: { mode: 'fixed', value: [64, 64] }, format: 'rgba8unorm', persistence: { clearOnResize: true, clearValue: 0 } }
    ],
    structs: [vertexOutputStruct],
    inputs: [],
    outputs: []
  };

  runFullGraphTest('Render Pipeline Triangle', doc, async (ctx) => {
    // Check center pixel (32, 32)
    // Should be Red (1, 0, 0, 1)
    // Background is 0 (initialized).

    // Texture data is flat float array (RGBA)
    const res = ctx.getResource(targetId);
    const data = res.data as number[];
    const idx = (32 * 64 + 32) * 4;

    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const a = data[idx + 3];

    if (r !== 1 || g !== 0 || b !== 0 || a !== 1) {
      throw new Error(`Expected Red (1,0,0,1) at center, got (${r},${g},${b},${a})`);
    }
  }, backends);
});
