import { describe, it, expect } from 'vitest';
import { CpuJitCompiler } from './cpu-jit';
import { IRDocument } from '../ir/types';

describe('CpuJitCompiler: Argument Resolution', () => {
  it('should resolve references inside arrays (e.g. dispatch dimensions)', () => {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'JIT Array Ref Test' },
      entryPoint: 'fn_main',
      inputs: [
        { id: 'u_kernel_size', type: 'int', default: 16 }
      ],
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
            { id: 'c1', op: 'cmd_dispatch', func: 'fn_compute', threads: ['u_kernel_size', 1, 1] }
          ]
        },
        { id: 'fn_compute', type: 'shader', inputs: [], outputs: [], localVars: [], nodes: [] }
      ]
    };

    const compiler = new CpuJitCompiler();
    const source = compiler.compileToSource(ir, 'fn_main');

    // Expected code should resolve u_kernel_size to ctx.inputs.get('u_kernel_size')
    // and form an array: [ctx.inputs.get('u_kernel_size'), 1, 1]
    expect(source).toContain("ctx.globals.dispatch('fn_compute', [ctx.inputs.get('u_kernel_size'), 1, 1]");
  });

  it('should resolve local variable references inside arrays', () => {
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'JIT Local Var Array Ref Test' },
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
          localVars: [
            { id: 'v_size', type: 'int', initialValue: 32 }
          ],
          nodes: [
            { id: 'c1', op: 'cmd_dispatch', func: 'fn_compute', threads: [1, 'v_size', 1] }
          ]
        },
        { id: 'fn_compute', type: 'shader', inputs: [], outputs: [], localVars: [], nodes: [] }
      ]
    };

    const compiler = new CpuJitCompiler();
    const source = compiler.compileToSource(ir, 'fn_main');

    // Expected code should resolve v_size to the sanitized local variable name (e.g., v_v_size)
    expect(source).toContain("ctx.globals.dispatch('fn_compute', [1, v_v_size, 1]");
  });
});
