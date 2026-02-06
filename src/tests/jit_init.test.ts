import { describe, it, expect, vi } from 'vitest';
import { CpuJitCompiler } from '../webgpu/cpu-jit';
import { IRDocument } from '../ir/types';

describe('JIT Initialization', () => {
  it('should emit an init function that returns an executor', async () => {
    const ir: IRDocument = {
      version: '1.0',
      meta: { name: 'test' },
      entryPoint: 'main',
      inputs: [],
      functions: [
        {
          id: 'main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'n1', op: 'call_func', func: 'shader', args: { x: 1, y: 1, z: 1 } }
          ]
        },
        {
          id: 'shader',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: []
        }
      ],
      structs: [],
      resources: []
    };

    const compiler = new CpuJitCompiler();
    const result = compiler.compile(ir, 'main');

    expect(result).toHaveProperty('task');
    expect(result).toHaveProperty('init');
    expect(result.init).toBeInstanceOf(Function);

    const mockDevice = {
      createShaderModule: vi.fn(() => ({})),
      createComputePipelineAsync: vi.fn(() => ({ getBindGroupLayout: () => { } })),
      createRenderPipelineAsync: vi.fn(() => ({ getBindGroupLayout: () => { } })),
      createBindGroup: vi.fn(),
      createBuffer: vi.fn(() => ({ destroy: () => { } })),
      createCommandEncoder: vi.fn(() => ({
        beginComputePass: vi.fn(() => ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          dispatchWorkgroups: vi.fn(),
          end: vi.fn()
        })),
        beginRenderPass: vi.fn(() => ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          setViewport: vi.fn(),
          setScissorRect: vi.fn(),
          draw: vi.fn(),
          end: vi.fn()
        })),
        finish: vi.fn()
      })),
      queue: {
        writeBuffer: vi.fn(),
        submit: vi.fn(),
        onSubmittedWorkDone: vi.fn()
      },
      pushErrorScope: vi.fn(),
      popErrorScope: vi.fn()
    } as any;

    const executor = await result.init(mockDevice);
    expect(executor).toHaveProperty('executeShader');
    expect(executor).toHaveProperty('executeDraw');
  });
});
