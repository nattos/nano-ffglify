import { describe, it, expect } from 'vitest';
import { runParametricTest, buildSimpleIR, availableBackends } from './test-runner';
import { validateIR } from '../../ir/validator';

describe('Conformance: Buffers', () => {

  runParametricTest('should handle Resize and Clear', [
    // 1. Write data
    { id: 'store', op: 'buffer_store', buffer: 'buf', index: 0, value: 50 },
    // 2. Resize
    { id: 'resize', op: 'cmd_resize_resource', resource: 'buf', size: 10 }
  ], (ctx) => {
    const res = ctx.getResource('buf');
    expect(res.width).toBe(10);
    // clearOnResize = true, so data should be empty/cleared (in ops.ts impl it resets array)
    expect(res.data).toEqual(new Array(10).fill(0));
  }, [
    {
      id: 'buf',
      type: 'buffer',
      size: { mode: 'fixed', value: 2 }, // Init size 2
      persistence: { retain: false, clearEveryFrame: false, clearOnResize: true, cpuAccess: false }
    }
  ], [
    { from: 'store', portOut: 'exec_out', to: 'resize', portIn: 'exec_in', type: 'execution' }

  ],
    [], // localVars
    [], // structs
    availableBackends.filter(b => b.name !== 'Compute')
  );

  runParametricTest('Typed Buffer Storage (vec4)', [
    { id: 'val', op: 'float4', x: 1, y: 2, z: 3, w: 4 },
    { id: 'store', op: 'buffer_store', buffer: 'b_vec', index: 0, value: 'val' },
    { id: 'val2', op: 'float4', x: 5, y: 6, z: 7, w: 8 },
    { id: 'store2', op: 'buffer_store', buffer: 'b_vec', index: 1, value: 'val2' }
  ], (ctx) => {
    const b_vec = (ctx.getResource('b_vec') as any).data;
    // Expected Layout:
    // [0]: (1,2,3,4)
    // [1]: (5,6,7,8) (Wait, stride alignment?)
    // In Array(8): 1,2,3,4, 5,6,7,8
    expect(Array.from(b_vec[0])).toEqual([1, 2, 3, 4]);
    expect(Array.from(b_vec[1])).toEqual([5, 6, 7, 8]);
  }, [
    {
      id: 'b_vec',
      type: 'buffer',
      dataType: 'vec4<f32>',
      size: { mode: 'fixed', value: 2 }, // 2 vec4s
      persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
    }
  ], [
    { from: 'store', portOut: 'exec_out', to: 'store2', portIn: 'exec_in', type: 'execution' }
  ], []);

  it('should detect Static OOB Write', () => {
    // Manually build IR to static check, no execution needed
    const ir = buildSimpleIR('Buffer OOB Write', [
      { id: 'store_oob', op: 'buffer_store', buffer: 'buf', index: 5, value: 100 }
    ], [
      { id: 'buf', type: 'buffer', size: { mode: 'fixed', value: 2 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }
    ]);

    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Static OOB');
  });

  it('should detect Static OOB Read', () => {
    const ir = buildSimpleIR('Buffer OOB Read', [
      { id: 'read_oob', op: 'buffer_load', buffer: 'buf', index: 5 },
      { id: 'sink', op: 'var_set', var: 'x', val: 'read_oob' }
    ], [
      { id: 'buf', type: 'buffer', size: { mode: 'fixed', value: 2 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }
    ]);

    // Wire data edge manually or rely on auto-wire (read_oob ID matches val)
    // buildSimpleIR auto-wires val.

    const errors = validateIR(ir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Static OOB');
  });

});
