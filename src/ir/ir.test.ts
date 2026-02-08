import { describe, it, expect } from 'vitest';
import { validateIR } from './schema';
import { IRDocument, TextureFormat } from './types';

describe('IR Validation', () => {
  it('should validate a minimal IR document', () => {
    const minimal: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Minimal' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [],
      structs: [],
      functions: [
        {
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: []
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
      version: '1.0.0',
      meta: { name: 'Precomputed Blur' },
      entryPoint: 'fn_main_cpu',
      inputs: [
        { id: 't_input', type: 'texture2d', format: 'rgba8' },
        { id: 'u_kernel_size', type: 'int', default: 16 }
      ],
      resources: [
        {
          id: 't_output',
          type: 'texture2d',
          format: TextureFormat.RGBA8,
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
      structs: [],
      functions: [
        {
          id: 'fn_main_cpu',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'resize_w', op: 'cmd_resize_resource', resource: 'b_weights', size: 'u_kernel_size' },
            { id: 'cmd_gen', op: 'cmd_dispatch', func: 'fn_gen_kernel', dispatch: [16, 1, 1] },
            { id: 'get_size', op: 'resource_get_size', resource: 't_input' },
            { id: 'calc_groups', op: 'math_div_scalar', val: 'get_size', scalar: 8 },
            { id: 'cmd_blur', op: 'cmd_dispatch', func: 'fn_blur', dispatch: [1, 1, 1] }
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
            { id: 'store', op: 'buffer_store', buffer: 'b_weights', index: 'idx', value: 1.0 }
          ]
        },
        {
          id: 'fn_blur',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [{ id: 'v_color', type: 'float4' }],
          nodes: [
            { id: 'loop', op: 'flow_loop', start: 0, end: 16 },
            { id: 'idx', op: 'loop_index', loop: 'loop' },
            { id: 'w_val', op: 'buffer_load', buffer: 'b_weights', index: 'idx' },
            { id: 'uv', op: 'float2', x: 0.5, y: 0.5 },
            { id: 'tex_val', op: 'texture_sample', tex: 't_input', uv: 'uv' }
          ]
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
      structs: [],
      functions: [
        {
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
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

  it('should detect Duplicate Node IDs', () => {
    const invalid: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Dup Node' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [],
      structs: [],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'n1', op: 'math_add' },
          { id: 'n1', op: 'math_sub' } // Duplicate
        ]
      }]
    };
    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = result.errors.find(e => e.message.includes("Duplicate Node ID 'n1'"));
      expect(err).toBeDefined();
      expect(err?.path).toContain('nodes');
      expect(err?.path).toContain('1'); // Index of duplicate
    }
  });

  it('should detect Duplicate Resource IDs', () => {
    const invalid: any = {
      version: '1.0.0',
      meta: { name: 'Dup Res' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [
        { id: 'res1', type: 'buffer', size: { mode: 'fixed', value: 10 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } },
        { id: 'res1', type: 'texture2d', size: { mode: 'fixed', value: [1, 1] }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }
      ],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [],
        edges: []
      }]
    };
    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = result.errors.find(e => e.message.includes("Duplicate Resource ID 'res1'"));
      expect(err).toBeDefined();
      // Path check
      expect(err?.path[0]).toBe('resources');
      expect(err?.path[2]).toBe('id');
    }
  });

  it('should detect Duplicate Function IDs', () => {
    const invalid: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Dup Func' },
      entryPoint: 'fn_1',
      inputs: [],
      resources: [],
      structs: [],
      functions: [
        { id: 'fn_1', type: 'cpu', inputs: [], outputs: [], localVars: [], nodes: [] },
        { id: 'fn_1', type: 'shader', inputs: [], outputs: [], localVars: [], nodes: [] }
      ]
    };
    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = result.errors.find(e => e.message.includes("Duplicate Function ID 'fn_1'"));
      expect(err).toBeDefined();
      expect(err?.path[0]).toBe('functions');
    }
  });
});

describe('Zod Schema Validation (Structural)', () => {
  it('should fail on missing required fields', () => {
    // Missing 'entryPoint'
    const invalid: any = {
      version: '1.0.0',
      meta: { name: 'Missing Entry' },
      // entryPoint missing
      inputs: [],
      resources: [],
      structs: [],
      functions: []
    };
    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = result.errors.find(e => e.path.includes('entryPoint') && e.code === 'invalid_type'); // distinct from custom semantic checks
      // actually Zod reports 'required' as invalid_type usually or specific code?
      // Zod 'required' check usually gives message "Required" and code "invalid_type".
      expect(err).toBeDefined();
    }
  });

  it('should fail on invalid property types', () => {
    const invalid: any = {
      version: 123, // Should be string
      meta: { name: 'Bad Version' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [],
      structs: [],
      functions: []
    };
    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = result.errors.find(e => e.path.includes('version'));
      expect(err).toBeDefined();
      expect(err?.message.toLowerCase()).toContain('expected string');
    }
  });

  it('should fail on invalid enum values', () => {
    const invalid: any = {
      version: '1.0.0',
      meta: { name: 'Bad Enum' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [
        {
          id: 'res1',
          type: 'not_a_valid_type', // Invalid Enum
          size: { mode: 'fixed', value: 10 },
          persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false }
        }
      ],
      structs: [],
      functions: []
    };
    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = result.errors.find(e => e.path.includes('resources') && e.path.includes('type'));
      expect(err).toBeDefined();
      expect(err?.message.toLowerCase()).toContain("expected one of"); // Zod terminology for enum
    }
  });

  it('should fail on unknown operator (op) enum', () => {
    const invalid: any = {
      version: '1.0.0',
      meta: { name: 'Unknown Op' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [],
      structs: [],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'n1', op: 'not_a_valid_op' } // Invalid Op Enum
        ]
      }]
    };
    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = result.errors.find(e => e.path.includes('nodes') && e.path.includes('op'));
      expect(err).toBeDefined();
      expect(err?.message.toLowerCase()).toContain("expected one of"); // Zod terminology for enum error
    }
  });

  it('should fail on unknown constant name in const_get', () => {
    const invalid: any = {
      version: '1.0.0',
      meta: { name: 'Unknown Const' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [],
      structs: [],
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'n1', op: 'const_get', name: 'TextureFormat.InvalidFormat' } // Invalid Const Name
        ]
      }]
    };
    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = result.errors.find(e => e.message.includes("Schema Error in 'const_get': name:"));
      expect(err).toBeDefined();
      expect(err?.message.toLowerCase()).toContain("expected one of");
    }
  });

  it('should fail on malformed union types (Resource Size)', () => {
    const invalid: any = {
      version: '1.0.0',
      meta: { name: 'Bad Size' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [
        {
          id: 'res1',
          type: 'buffer',
          // mode 'fixed' requires 'value'
          size: { mode: 'fixed' },
          persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false }
        }
      ],
      structs: [],
      functions: []
    };
    const result = validateIR(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod union errors are sometimes verbose, reporting issues for each union option.
      // But typically it says "Invalid input" or specific missing field if it matches closest.
      // Since 'mode' is 'fixed', it likely tries to match the 'fixed' object schema and fails on missing 'value'.
      const err = result.errors.find(e => e.path.includes('resources') && e.path.includes('size'));
      expect(err).toBeDefined();
    }
  });
});
