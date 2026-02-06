
import { describe, expect, it } from 'vitest';
import { runFullGraphTest, cpuBackends } from './test-runner';
import { IRDocument, TextureFormat } from '../../ir/types';

// CPU specific tests
const backends = cpuBackends;

describe('Conformance: Bind Group Layouts', () => {
  if (backends.length === 0) {
    it.skip('Skipping Bind Group tests (no WebGPU backend)', () => { });
    return;
  }

  // 1. Empty Inputs (Only injected u_dispatch_size)
  describe('Empty Inputs', () => {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Empty Inputs' },
      entryPoint: 'main',
      inputs: [],
      resources: [
        {
          id: 'b_res',
          type: 'buffer',
          dataType: 'float',
          size: { mode: 'fixed', value: 3 },
          persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false }
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
            { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1] }
          ]
        },
        {
          id: 'shader_main',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            // Use u_dispatch_size (implicitly injected) or just write constant
            // WgslGenerator injects u_dispatch_size into Inputs struct.
            // If we don't access it, it's still there.
            // We write to buffer to prove execution happened.
            { id: 'val', op: 'float', val: 123.0 },
            { id: 's0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'val' }
          ]
        }
      ]
    };

    runFullGraphTest('should work with no user inputs', ir, (ctx) => {
      const res = ctx.getResource('b_res');
      expect(res.data?.[0]).toBe(123);
    }, backends);
  });

  // 2. Unused Resources
  describe('Unused Resources', () => {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Unused Resources' },
      entryPoint: 'main',
      inputs: [],
      resources: [
        { id: 'b_used', type: 'buffer', dataType: 'float', size: { mode: 'fixed', value: 1 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } },
        { id: 'b_unused', type: 'buffer', dataType: 'float', size: { mode: 'fixed', value: 1 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } },
        { id: 't_unused', type: 'texture2d', format: TextureFormat.RGBA8, size: { mode: 'fixed', value: [4, 4] }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }
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
            { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1] }
          ]
        },
        {
          id: 'shader_main',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'val', op: 'float', val: 456.0 },
            { id: 's0', op: 'buffer_store', buffer: 'b_used', index: 0, value: 'val' }
            // b_unused and t_unused are NOT used
          ]
        }
      ]
    };

    runFullGraphTest('which should be filtered out from bind group', ir, (ctx) => {
      const res = ctx.getResource('b_used');
      expect(res.data?.[0]).toBe(456);
      // If validation fails (bind group mismatch), this test will fail during execution
    }, backends);
  });

  // 3. Mixed Inputs and Resources
  describe('Mixed Inputs and Resources', () => {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Mixed Bindings' },
      entryPoint: 'main',
      inputs: [],
      resources: [
        { id: 'b_res', type: 'buffer', dataType: 'float', size: { mode: 'fixed', value: 1 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }
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
            { id: 'v', op: 'float', val: 789.0 },
            { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1], args: { val: 'v' } }
          ]
        },
        {
          id: 'shader_main',
          type: 'shader',
          inputs: [{ id: 'val', type: 'float' }],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 's0', op: 'buffer_store', buffer: 'b_res', index: 0, value: 'val' }
          ]
        }
      ]
    };

    runFullGraphTest('have correct binding indices', ir, (ctx) => {
      const res = ctx.getResource('b_res');
      expect(res.data?.[0]).toBe(789);
    }, backends);
    // 4. resource_get_size Bindings
    describe('resource_get_size Bindings', () => {
      const ir: IRDocument = {
        version: '1.0.0',
        meta: { name: 'Resource Get Size' },
        entryPoint: 'main',
        inputs: [],
        resources: [
          { id: 'b_test', type: 'buffer', dataType: 'float', size: { mode: 'fixed', value: 42 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } },
          { id: 'b_output', type: 'buffer', dataType: 'float', size: { mode: 'fixed', value: 1 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }
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
              { id: 'disp', op: 'cmd_dispatch', func: 'shader_main', dispatch: [1, 1, 1] }
            ]
          },
          {
            id: 'shader_main',
            type: 'shader',
            inputs: [],
            outputs: [],
            localVars: [],
            nodes: [
              { id: 'size_vec', op: 'resource_get_size', resource: 'b_test' },
              { id: 'size_x', op: 'vec_get_element', vec: 'size_vec', index: 0 },
              { id: 's0', op: 'buffer_store', buffer: 'b_output', index: 0, value: 'size_x' }
            ]
          }
        ]
      };

      runFullGraphTest('properly binds resource touched only by get_size', ir, (ctx) => {
        const res = ctx.getResource('b_output');
        expect(res.data?.[0]).toBe(42);
      }, backends);
    });
  });
});
