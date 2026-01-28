import { describe, it, expect } from 'vitest';
import { validateIR } from './schema';
import { IRDocument } from './types';

describe('IR Validation', () => {
  it('should validate a minimal IR document', () => {
    const minimal: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Minimal' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [],
      functions: [
        {
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [],
          edges: []
        }
      ]
    };

    const result = validateIR(minimal);
    if (!result.success) {
      console.error(result.errors);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entryPoint).toBe('fn_main');
    }
  });

  it('should validate the complex Precomputed Blur example', () => {
    const complex: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Precomputed Blur' },
      entryPoint: 'fn_main_cpu',
      inputs: [
        { id: 't_input', type: 'texture2d' },
        { id: 'u_kernel_size', type: 'int', default: 16 }
      ],
      resources: [
        {
          id: 't_output',
          type: 'texture2d',
          size: { mode: 'reference', ref: 't_input' },
          persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
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
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'resize_w', op: 'cmd_resize_resource', resource: 'b_weights', size: 'u_kernel_size' },
            { id: 'cmd_gen', op: 'cmd_dispatch', func: 'fn_gen_kernel', dispatch: [1, 1, 1] },
            { id: 'get_size', op: 'resource_get_size', resource: 't_input' },
            { id: 'calc_groups', op: 'math_div_scalar', val: 8 },
            { id: 'cmd_blur', op: 'cmd_dispatch', func: 'fn_blur' }
          ],
          edges: [
            { from: 'resize_w', portOut: 'exec_out', to: 'cmd_gen', portIn: 'exec_in', type: 'execution' }
          ]
        },
        {
          id: 'fn_gen_kernel',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [{ id: 'v_sum', type: 'float' }],
          nodes: [
            { id: 'loop', op: 'flow_loop', start: 0, end: 16 },
            { id: 'idx', op: 'loop_index', loop: 'loop' },
            { id: 'store', op: 'buffer_store', buffer: 'b_weights', index: 'idx' }
          ],
          edges: []
        },
        {
          id: 'fn_blur',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [{ id: 'v_color', type: 'vec4' }],
          nodes: [
            { id: 'loop', op: 'flow_loop', start: 0, end: 16 },
            { id: 'idx', op: 'loop_index', loop: 'loop' },
            { id: 'w_val', op: 'buffer_load', buffer: 'b_weights', index: 'idx' },
            { id: 'tex_val', op: 'texture_sample', tex: 't_input' }
          ],
          edges: []
        }
      ]
    };

    const result = validateIR(complex);
    if (!result.success) {
      console.error(result.errors);
    }
    expect(result.success).toBe(true);
  });

  it('should detect invalid Entry Point', () => {
    const invalid: any = {
      version: '1.0.0',
      meta: { name: 'Bad' },
      entryPoint: 'missing_func',
      inputs: [],
      resources: [],
      functions: []
    };

    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some(e => e.message.includes('Entry Point function \'missing_func\' not found'))).toBe(true);
    }
  });

  it('should detect invalid Resource Reference', () => {
    const invalid: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Bad Ref' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [],
      functions: [
        {
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          edges: [],
          nodes: [
            // 't_missing' does not exist
            { id: 'n1', op: 'texture_sample', tex: 't_missing' }
          ]
        }
      ]
    };

    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.errors.find(e => e.message.includes('references unknown resource \'t_missing\''));
      expect(error).toBeDefined();
    }
  });
});
