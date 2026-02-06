/**
 * @file mock-responses.ts
 * @description A registry of deterministic LLM responses for test/demo scripts.
 * Used when `useMockLLM` is active or during automated tests.
 */
import { LLMResponse } from '../llm/llm-manager';

export const NOTES_MOCKS: Record<string, LLMResponse> = {
  "hello": {
    text: "Hello! I am your WebGPU IR Assistant. I can help you create, modify, and validate shader graphs."
  },
  "create a blur pipeline": {
    text: "I've created a precomputed blur pipeline IR document for you.",
    tool_calls: [{
      name: "replaceIR",
      arguments: {
        version: '1.0.0',
        meta: { name: 'Precomputed Blur' },
        comment: 'This is a test pipeline demonstrating resize, generation, and blur phases with dynamic dimensions.',
        entryPoint: 'fn_main_cpu',
        inputs: [
          { id: 't_input', type: 'texture2d', format: 'rgba8', comment: 'Source image for blur' },
          { id: 't_overlay', type: 'texture2d', format: 'rgba8', comment: 'Optional overlay texture' },
          { id: 'u_kernel_size', type: 'int', default: 16, ui: { min: 1, max: 64, widget: 'slider' }, comment: 'Size of the blur kernel' },
          { id: 'u_brightness', type: 'float', default: 1.0, ui: { min: 0.0, max: 2.0, widget: 'slider' }, comment: 'Brightness multiplier' },
          { id: 'u_invert', type: 'bool', default: false, comment: 'Invert colors' },
          { id: 'u_color_tint', type: 'float4', default: [1.0, 1.0, 1.0, 1.0], comment: 'Color tint' }
        ],
        structs: [],
        resources: [
          {
            id: 't_output',
            type: 'texture2d',
            format: 'rgba8',
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
              // 1. Resize Weights
              { id: 'resize_w', op: 'cmd_resize_resource', resource: 'b_weights', size: 'u_kernel_size' },

              // 2. Get Input/Output dimensions
              { id: 'out_size', op: 'resource_get_size', resource: 't_output' },
              { id: 'out_w', op: 'vec_get_element', vec: 'out_size', index: 0 },
              { id: 'out_h', op: 'vec_get_element', vec: 'out_size', index: 1 },

              // 3. Dispatch Gen
              { id: 'cmd_gen', op: 'cmd_dispatch', func: 'fn_gen_kernel', dispatch: ['u_kernel_size', 1, 1], exec_in: 'resize_w' },

              // 4. Dispatch Blur using dynamic dimensions
              { id: 'cmd_blur', op: 'cmd_dispatch', func: 'fn_blur', dispatch: ['out_w', 'out_h', 1], args: { u_kernel_size: 'u_kernel_size' }, exec_in: 'cmd_gen' }
            ]
          },
          {
            id: 'fn_gen_kernel',
            type: 'shader',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'th_id', op: 'builtin_get', name: 'global_invocation_id' },
              { id: 'idx', op: 'vec_get_element', vec: 'th_id', index: 0 },
              { id: 'val', op: 'math_mul', a: 'idx', b: 0.0025 },
              { id: 'v_val', op: 'float4', x: 'val', y: 'val', z: 'val', w: 'val' },
              { id: 'store', op: 'buffer_store', buffer: 'b_weights', index: 'idx', value: 'v_val' }
            ]
          },
          {
            id: 'fn_blur',
            type: 'shader',
            inputs: [
              { id: 'u_kernel_size', type: 'int' }
            ],
            outputs: [],
            localVars: [
              { id: 'v_sum', type: 'float4', initialValue: [0, 0, 0, 0] }
            ],
            nodes: [
              { id: 'th_id', op: 'builtin_get', name: 'global_invocation_id' },
              { id: 'x', op: 'vec_get_element', vec: 'th_id', index: 0 },
              { id: 'y', op: 'vec_get_element', vec: 'th_id', index: 1 },
              { id: 'coords', op: 'float2', x: 'x', y: 'y' },

              // Get Texture Size
              { id: 'size_f', op: 'resource_get_size', resource: 't_output' },
              { id: 'width_f', op: 'vec_get_element', vec: 'size_f', index: 0 },
              { id: 'height_f', op: 'vec_get_element', vec: 'size_f', index: 1 },

              // Calculate UV for Base Image (Top-Left 0,0)
              { id: 'f_x', op: 'static_cast_float', val: 'x' },
              { id: 'f_y', op: 'static_cast_float', val: 'y' },
              { id: 'mid_x', op: 'math_add', a: 'f_x', b: 0.5 },
              { id: 'mid_y', op: 'math_add', a: 'f_y', b: 0.5 },
              { id: 'u', op: 'math_div', a: 'mid_x', b: 'width_f' },
              { id: 'v', op: 'math_div', a: 'mid_y', b: 'height_f' },
              { id: 'uv', op: 'float2', x: 'u', y: 'v' },

              // --- Kernel Loop: Sum Weighted Samples ---
              {
                id: 'loop',
                op: 'flow_loop',
                start: 0,
                end: 'u_kernel_size',
                exec_body: 'accumulate',
                exec_completed: 'store'
              },

              // Loop Body
              { id: 'idx_loop', op: 'loop_index', loop: 'loop' },

              // 1. Calculate Offset: (idx - size/2)
              { id: 'size_half', op: 'math_div', a: 'u_kernel_size', b: 2 },
              { id: 'idx_offset_i', op: 'math_sub', a: 'idx_loop', b: 'size_half' },
              { id: 'idx_offset_f', op: 'static_cast_float', val: 'idx_offset_i' },

              // 2. Convert to UV Offset: offset / width
              { id: 'u_offset_n', op: 'math_div', a: 'idx_offset_f', b: 'width_f' },
              { id: 'u_offset', op: 'math_mul', a: 'u_offset_n', b: 1.8 },
              { id: 'v_offset', op: 'float2', x: 'u_offset', y: 0.0 }, // Horizontal Blur

              // 3. Sample UV
              { id: 'sample_uv', op: 'math_add', a: 'uv', b: 'v_offset' },

              // 4. Load Weight
              { id: 'idx_clamped', op: 'math_clamp', val: 'idx_loop', min: 0, max: 15 },
              { id: 'weight_val', op: 'buffer_load', buffer: 'b_weights', index: 'idx_clamped' },

              // 5. Sample & Weight
              { id: 'sample_col', op: 'texture_sample', tex: 't_input', uv: 'sample_uv' },
              { id: 'weighted_col', op: 'math_mul', a: 'sample_col', b: 'weight_val' },

              // 6. Accumulate
              { id: 'curr_sum', op: 'var_get', var: 'v_sum' },
              { id: 'new_sum', op: 'math_add', a: 'curr_sum', b: 'weighted_col' },

              { id: 'accumulate', op: 'var_set', var: 'v_sum', val: 'new_sum' },

              // --- Post-Loop ---

              // Store Result directly
              { id: 'final_color', op: 'var_get', var: 'v_sum' },
              { id: 'store', op: 'texture_store', tex: 't_output', coords: 'coords', value: 'final_color' }
            ]
          }
        ]
      }
    }]
  },
  "change the kernel size to 32": {
    text: "I've updated the kernel size to 32.",
    tool_calls: [{
      name: "patchIR",
      arguments: [{ op: "replace", path: "/inputs/2/default", value: 32 }]
    }]
  }
};

export const DEMO_SCRIPT = Object.keys(NOTES_MOCKS);
