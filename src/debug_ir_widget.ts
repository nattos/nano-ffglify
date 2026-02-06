import './views/components/ui-ir-widget';
import { IRDocument } from './ir/types';

// Hard-coded IR graph (copy of the blur pipeline)
const MOCK_IR: IRDocument = {
  version: '1.0.0',
  meta: { name: 'Precomputed Blur Debug' },
  comment: 'This is a test pipeline demonstrating resize, generation, and blur phases.',
  entryPoint: 'fn_main_cpu',
  inputs: [
    { id: 't_input', type: 'texture2d', format: 'rgba8' as any, comment: 'Source image for blur' },
    { id: 'u_kernel_size', type: 'int', default: 16, comment: 'Size of the blur kernel' }
  ],
  structs: [],
  resources: [
    {
      id: 't_output',
      type: 'texture2d',
      format: 'rgba8' as any,
      size: { mode: 'reference', ref: 't_input' },
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
    },
    {
      id: 'b_weights',
      type: 'buffer',
      dataType: 'float4',
      size: { mode: 'cpu_driven' },
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
    }
  ],
  functions: [
    {
      id: 'fn_main_cpu',
      type: 'cpu',
      comment: 'Main CPU Orchestrator',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'resize_w', op: 'cmd_resize_resource', resource: 'b_weights', size: 'u_kernel_size' },
        { id: 'out_size', op: 'resource_get_size', resource: 't_output' },
        { id: 'out_w', op: 'vec_get_element', vec: 'out_size', index: 0 },
        { id: 'out_h', op: 'vec_get_element', vec: 'out_size', index: 1 },
        { id: 'cmd_gen', op: 'cmd_dispatch', func: 'fn_gen_kernel', x: 'u_kernel_size', y: 1, exec_in: 'resize_w' },
        { id: 'cmd_blur', op: 'cmd_dispatch', func: 'fn_blur', x: 'out_w', y: 'out_h', u_kernel_size: 'u_kernel_size', exec_in: 'cmd_gen' }
      ]
    },
    {
      id: 'fn_gen_kernel',
      type: 'shader',
      comment: 'Kernel Generation shader',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'th_id', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'idx', op: 'vec_get_element', vec: 'th_id', index: 0 },
        { id: 'val', op: 'math_mul', a: 'idx', b: 0.1 },
        { id: 'v_val', op: 'float4', x: 'val', y: 'val', z: 'val', w: 'val' },
        { id: 'store', op: 'buffer_store', buffer: 'b_weights', index: 'idx', value: 'v_val' }
      ]
    },
    {
      id: 'fn_blur',
      type: 'shader',
      comment: 'Main blur shader stage',
      inputs: [{ id: 'u_kernel_size', type: 'int', comment: 'Size of the kernel passed from host' }],
      outputs: [],
      localVars: [{ id: 'v_color', type: 'float4', initialValue: [0, 0, 0, 0], comment: 'Accumulated color' }],
      nodes: [
        { id: 'th_id', op: 'builtin_get', name: 'global_invocation_id' },
        { id: 'x', op: 'vec_get_element', vec: 'th_id', index: 0 },
        { id: 'y', op: 'vec_get_element', vec: 'th_id', index: 1 },
        { id: 'coords', op: 'float2', x: 'x', y: 'y' },
        { id: 'half_k_int', op: 'math_div', a: 'u_kernel_size', b: 2 },
        { id: 'half_k', op: 'static_cast_float', val: 'half_k_int' },
        { id: 'loop', op: 'flow_loop', start: 0, end: 'u_kernel_size', exec_body: 'set', exec_completed: 'store' },
        { id: 'idx_int', op: 'loop_index', loop: 'loop' },
        { id: 'idx_f', op: 'static_cast_float', val: 'idx_int' },
        { id: 'offset_x', op: 'math_sub', a: 'idx_f', b: 'half_k' },
        { id: 'offset_vec', op: 'float2', x: 'offset_x', y: 0 },
        { id: 'sample_coords', op: 'math_add', a: 'coords', b: 'offset_vec' },
        { id: 'w_val', op: 'buffer_load', buffer: 'b_weights', index: 'idx_int' },
        { id: 'size', op: 'resource_get_size', resource: 't_input' },
        { id: 'uv', op: 'math_div', a: 'sample_coords', b: 'size' },
        { id: 'tex_val', op: 'texture_sample', tex: 't_input', uv: 'uv' },
        { id: 'prev', op: 'var_get', var: 'v_color' },
        { id: 'new_val', op: 'math_mad', a: 'tex_val', b: 'w_val', c: 'prev' },
        { id: 'set', op: 'var_set', var: 'v_color', val: 'new_val' },
        { id: 'final_color', op: 'var_get', var: 'v_color' },
        { id: 'store', op: 'texture_store', tex: 't_output', coords: 'coords', value: 'final_color' }
      ]
    },
    {
      id: 'fn_dummy',
      type: 'cpu',
      comment: 'A dummy function for scoping tests',
      inputs: [],
      outputs: [],
      localVars: [{ id: 'v_color', type: 'float4', initialValue: [1, 1, 1, 1], comment: 'Dummy local color' }],
      nodes: [
        { id: 'get', op: 'var_get', var: 'v_color' },
        { id: 'ret', op: 'func_return', val: 'get' }
      ]
    }
  ]
};

window.addEventListener('DOMContentLoaded', () => {
  const widget = document.getElementById('debug-widget') as any;
  if (widget) {
    widget.ir = MOCK_IR;
  }
});
