/**
 * @file mock-responses.ts
 * @description A registry of deterministic LLM responses for test/demo scripts.
 * Used when `useMockLLM` is active or during automated tests.
 */
import { LLMResponse } from '../llm/llm-manager';

export const NOTES_MOCKS: Record<string, LLMResponse | LLMResponse[]> = {
  "hello": [
    {
      text: "Hello! I am your WebGPU IR Assistant.",
      tool_calls: [{ name: "final_response", arguments: { text: "I can help you create, modify, and validate shader graphs. What would you like to build today?" } }]
    }
  ],
  "do some research": [
    {
      text: "I'm looking up the docs for several operations.",
      // tool_calls: [{ name: "final_response", arguments: { text: "I can help you create, modify, and validate shader graphs. What would you like to build today?" } }]
      tool_calls: [
        {
          "name": "queryDocs",
          "arguments": {
          }
        },
        {
          "name": "queryDocs",
          "arguments": {
            "op": "texture_sample_lod"
          }
        },
        {
          "name": "queryDocs",
          "arguments": {
            "op": "texture_store"
          }
        },
        {
          "name": "queryDocs",
          "arguments": {
            "op": "cmd_dispatch"
          }
        },
        {
          "name": "queryDocs",
          "arguments": {
            "op": "math_add"
          }
        },
        {
          "name": "queryDocs",
          "arguments": {
            "op": "math_div"
          }
        },
        {
          "name": "queryDocs",
          "arguments": {
            "op": "call_func"
          }
        },
        {
          "name": "queryDocs",
          "arguments": {
            "op": "builtin_get"
          }
        },
        {
          "name": "queryDocs",
          "arguments": {
            "op": "const_get"
          }
        },
        { name: "final_response", arguments: { text: "Done." } }
      ]
    }
  ],
  "create a blur pipeline": [
    {
      text: "I'm setting up the blur pipeline for you...",
      tool_calls: [
        {
          name: "replaceIR",
          arguments: {
            id: 'blur-ir',
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
                  { id: 'resize_w', op: 'cmd_resize_resource', resource: 'b_weights', size: 'u_kernel_size' },
                  { id: 'out_size', op: 'resource_get_size', resource: 't_output' },
                  { id: 'out_w', op: 'vec_get_element', vec: 'out_size', index: 0 },
                  { id: 'out_h', op: 'vec_get_element', vec: 'out_size', index: 1 },
                  { id: 'cmd_gen', op: 'cmd_dispatch', func: 'fn_gen_kernel', dispatch: ['u_kernel_size', 1, 1], exec_in: 'resize_w' },
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
                  { id: 'size_f', op: 'resource_get_size', resource: 't_output' },
                  { id: 'width_f', op: 'vec_get_element', vec: 'size_f', index: 0 },
                  { id: 'height_f', op: 'vec_get_element', vec: 'size_f', index: 1 },
                  { id: 'f_x', op: 'static_cast_float', val: 'x' },
                  { id: 'f_y', op: 'static_cast_float', val: 'y' },
                  { id: 'mid_x', op: 'math_add', a: 'f_x', b: 0.5 },
                  { id: 'mid_y', op: 'math_add', a: 'f_y', b: 0.5 },
                  { id: 'u', op: 'math_div', a: 'mid_x', b: 'width_f' },
                  { id: 'v', op: 'math_div', a: 'mid_y', b: 'height_f' },
                  { id: 'uv', op: 'float2', x: 'u', y: 'v' },
                  {
                    id: 'loop',
                    op: 'flow_loop',
                    start: 0,
                    end: 'u_kernel_size',
                    exec_body: 'accumulate',
                    exec_completed: 'store'
                  },
                  { id: 'idx_loop', op: 'loop_index', loop: 'loop' },
                  { id: 'size_half', op: 'math_div', a: 'u_kernel_size', b: 2 },
                  { id: 'idx_offset_i', op: 'math_sub', a: 'idx_loop', b: 'size_half' },
                  { id: 'idx_offset_f', op: 'static_cast_float', val: 'idx_offset_i' },
                  { id: 'u_offset_n', op: 'math_div', a: 'idx_offset_f', b: 'width_f' },
                  { id: 'u_offset', op: 'math_mul', a: 'u_offset_n', b: 1.8 },
                  { id: 'v_offset', op: 'float2', x: 'u_offset', y: 0.0 },
                  { id: 'sample_uv', op: 'math_add', a: 'uv', b: 'v_offset' },
                  { id: 'idx_clamped', op: 'math_clamp', val: 'idx_loop', min: 0, max: 15 },
                  { id: 'weight_val', op: 'buffer_load', buffer: 'b_weights', index: 'idx_clamped' },
                  { id: 'sample_col', op: 'texture_sample', tex: 't_input', coords: 'sample_uv' },
                  { id: 'weighted_col', op: 'math_mul', a: 'sample_col', b: 'weight_val' },
                  { id: 'curr_sum', op: 'var_get', var: 'v_sum' },
                  { id: 'new_sum', op: 'math_add', a: 'curr_sum', b: 'weighted_col' },
                  { id: 'accumulate', op: 'var_set', var: 'v_sum', val: 'new_sum' },
                  { id: 'final_color', op: 'var_get', var: 'v_sum' },
                  { id: 'store', op: 'texture_store', tex: 't_output', coords: 'coords', value: 'final_color' }
                ]
              }
            ]
          }
        }
      ]
    },
    {
      tool_calls: [{ name: "final_response", arguments: { text: "I've created a precomputed blur pipeline IR document for you." } }]
    }
  ],
  "introduce a compile error": {
    text: "I'll purposely break the compilation by introducing an invalid operation...",
    tool_calls: [
      {
        name: "patchIR",
        arguments: { patches: [{ op: "replace", path: "/functions/1/nodes/2/op", value: "math_broken_op" }] }
      },
      {
        name: "final_response",
        arguments: { text: "I've introduced a breaking change. Let's see how the system reacts." }
      }
    ]
  },
  "fix the compile error": {
    text: "Correcting the invalid operation now...",
    tool_calls: [
      {
        name: "patchIR",
        arguments: { patches: [{ op: "replace", path: "/functions/1/nodes/2/op", value: "math_mul" }] }
      },
      {
        name: "final_response",
        arguments: { text: "The operation has been restored to `math_mul`. Compilation should now succeed." }
      }
    ]
  },
  "how do i use math_add": [
    {
      text: "Let me check the documentation for `math_add`...",
      tool_calls: [{
        name: "queryDocs",
        arguments: { op: "math_add" }
      }]
    },
    {
      tool_calls: [{ name: "final_response", arguments: { text: "As shown above, `math_add` takes two parameters 'a' and 'b' and returns their sum. You can use it with both scalar and vector types." } }]
    }
  ],
  "change the kernel size to 32": {
    text: "I've updated the kernel size to 32.",
    tool_calls: [
      {
        name: "patchIR",
        arguments: { patches: [{ op: "replace", path: "/inputs/2/default", value: 32 }] }
      },
      {
        name: "final_response",
        arguments: { text: "The kernel size has been successfully updated to 32 in the IR." }
      }
    ]
  }
};

export const DEMO_SCRIPT = Object.keys(NOTES_MOCKS);
