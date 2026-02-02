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
      name: "upsertIR",
      arguments: {
        entity: {
          id: "blur-ir",
          version: '3.0.0',
          meta: { name: 'Precomputed Blur' },
          comment: 'This is a test pipeline demonstrating resize, generation, and blur phases.',
          entryPoint: 'fn_main_cpu',
          inputs: [
            { id: 't_input', type: 'texture2d', format: 'rgba8', comment: 'Source image for blur' },
            { id: 'u_kernel_size', type: 'int', default: "16" }
          ],
          structs: [],
          resources: [
            {
              id: 't_output',
              type: 'texture2d',
              format: 'rgba8',
              size: { mode: 'reference', ref: 't_input' },
              persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false },
              comment: 'Blurred result texture'
            },
            {
              id: 'b_weights',
              type: 'buffer',
              dataType: 'float',
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
                { id: 'cmd_gen', op: 'cmd_dispatch', func: 'fn_gen_kernel', dispatch: [4, 1, 1], comment: 'Generate weights in parallel' },
                { id: 'cmd_blur', op: 'cmd_dispatch', func: 'fn_blur', dispatch: [1, 1, 1] }
              ],
              edges: [
                { from: 'resize_w', portOut: 'exec_out', to: 'cmd_gen', portIn: 'exec_in', type: 'execution' },
                { from: 'cmd_gen', portOut: 'exec_out', to: 'cmd_blur', portIn: 'exec_in', type: 'execution', comment: 'Wait for Gen to finish' }
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
                { id: 'val', op: 'math_mul', a: 'idx', b: 10 },
                { id: 'store', op: 'buffer_store', buffer: 'b_weights', index: 'idx', value: 'val' }
              ],
              edges: [
                { from: 'th_id', portOut: 'val', to: 'idx', portIn: 'vec', type: 'data' },
                { from: 'idx', portOut: 'val', to: 'val', portIn: 'a', type: 'data' },
                { from: 'idx', portOut: 'val', to: 'store', portIn: 'index', type: 'data' },
                { from: 'val', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
              ]
            },
            {
              id: 'fn_blur',
              type: 'shader',
              inputs: [],
              outputs: [],
              localVars: [],
              nodes: [
                { id: 'th_id', op: 'builtin_get', name: 'global_invocation_id' },
                { id: 'x', op: 'vec_get_element', vec: 'th_id', index: 0 },
                { id: 'y', op: 'vec_get_element', vec: 'th_id', index: 1 },
                { id: 'coords', op: 'float2', x: 'x', y: 'y' },
                { id: 'w_val', op: 'buffer_load', buffer: 'b_weights', index: 2 },
                { id: 'color', op: 'float4', x: 'w_val', y: 0, z: 0, w: 1 },
                { id: 'store', op: 'texture_store', tex: 't_output', coords: 'coords', value: 'color' }
              ],
              edges: [
                { from: 'th_id', portOut: 'val', to: 'x', portIn: 'vec', type: 'data' },
                { from: 'th_id', portOut: 'val', to: 'y', portIn: 'vec', type: 'data' },
                { from: 'x', portOut: 'val', to: 'coords', portIn: 'x', type: 'data' },
                { from: 'y', portOut: 'val', to: 'coords', portIn: 'y', type: 'data' },
                { from: 'w_val', portOut: 'val', to: 'color', portIn: 'x', type: 'data' },
                { from: 'coords', portOut: 'val', to: 'store', portIn: 'coords', type: 'data' },
                { from: 'color', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
              ]
            }
          ]
        }
      }
    }]
  },
  "change the kernel size to 32": {
    text: "I've updated the kernel size to 32.",
    tool_calls: [{
      name: "patchIR",
      arguments: {
        id: "blur-ir",
        patches: [{ op: "replace", path: "/inputs/1/default", value: 32 }]
      }
    }]
  }
};

export const DEMO_SCRIPT = Object.keys(NOTES_MOCKS);
