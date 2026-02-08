import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from '../src/domain/state';
import { chatHandler } from '../src/llm/chat-handler';
import { appController } from '../src/state/controller';
import { IRDocument } from '../src/domain/types';
import { CompilationArtifacts } from '../src/runtime/repl-manager';

// Mock settings to force useMockLLM = true
vi.mock('../src/state/settings', () => ({
  settingsManager: {
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    loadDatabase: vi.fn(),
    saveDatabase: vi.fn()
  }
}));

// Mock WebGPU Globals
global.GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 } as any;
global.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, STORAGE_BINDING: 128, COPY_SRC: 1, COPY_DST: 2 } as any;


describe('Integration: IR App Scenarios', () => {

  beforeEach(() => {
    runInAction(() => {
      // Reset State
      appState.database = {
        ir: { version: '1.0', meta: { name: 'Empty' }, entryPoint: '', inputs: [], resources: [], structs: [], functions: [] },
        chat_history: []
      };

      appState.local.settings.useMockLLM = true;
    });
  });

  it('Scenario: Create and Update Blur Pipeline', async () => {
    // 1. Create Blur Pipeline
    await chatHandler.handleUserMessage("create a blur pipeline");

    runInAction(() => {
      const ir = appState.database.ir;
      expect(ir).toBeDefined();
      expect(ir.meta.name).toBe('Precomputed Blur');
    });

    // 2. Update Kernel Size
    await chatHandler.handleUserMessage("change the kernel size to 32");

    runInAction(() => {
      const ir = appState.database.ir;
      expect(ir.meta.name).toBe('Precomputed Blur');
      expect(ir.inputs[2].default).toBe(32);
    });
  });

  it('Scenario: Querying Documentation', async () => {
    // 1. Ask for documentation
    await chatHandler.handleUserMessage("how do i use math_add");

    runInAction(() => {
      // The chat history should contain the tool execution output
      const history = appState.database.chat_history;

      // Look for the documentation message
      const docMessage = history.find(m => m.role === 'tool-response' && m.data?.docsResult?.name === 'math_add');
      expect(docMessage).toBeDefined();
      expect(docMessage?.data.docsResult.name).toBe('math_add');
      expect(docMessage?.data.docsResult.description).toContain('Standard numeric binary math operation.');
    });
  });
  it('Scenario: Reference Sizing Propagation', async () => {
    // 1. Create a graph with input and dependent resource
    const ir: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Ref Test' },
      entryPoint: 'main',
      inputs: [
        { id: 't_input', type: 'texture2d' }
      ],
      resources: [
        {
          id: 't_derived',
          type: 'texture2d',
          size: { mode: 'reference', ref: 't_input' },
          persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false }
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
          nodes: []
        }
      ]
    };

    const artifacts: CompilationArtifacts = {
      ir,
      compiled: {
        initCode: '',
        taskCode: '',
        init: async () => ({
          executeShader: async () => { },
          executeDraw: async () => { },
          executeSyncToCpu: () => { },
          executeWaitCpuSync: async () => { }
        }),
        task: async () => 0
      },
      wgsl: {}
    };

    // 2. Load into Runtime
    // Mock device
    const device = {
      createTexture: vi.fn(() => ({ destroy: vi.fn(), width: 100, height: 100 })),
      createShaderModule: vi.fn(),
      createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn() })),
      createSampler: vi.fn(),
      createBuffer: vi.fn(),
      queue: { writeBuffer: vi.fn(), copyExternalImageToTexture: vi.fn(), submit: vi.fn() },
      createCommandEncoder: vi.fn(() => ({
        beginRenderPass: vi.fn(() => ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          draw: vi.fn(),
          end: vi.fn()
        })),
        finish: vi.fn()
      })),
      createBindGroup: vi.fn()
    } as any;

    await appController.runtime.setCompiled(artifacts, device);

    // 3. Trigger Input Resize (simulate file load)
    const tInput = appController.runtime.getResource('t_input');
    const tDerived = appController.runtime.getResource('t_derived');

    // Default width is PATCH_SIZE (1920x1080)
    expect(tInput?.width).toBe(1920);
    expect(tDerived?.width).toBe(1920);

    // Simulate dynamic resize call (internal method)
    // @ts-ignore
    appController.runtime.resizeResource('t_input', 800, 600);

    expect(tInput?.width).toBe(800);
    expect(tDerived?.width).toBe(800);
    expect(tDerived?.height).toBe(600);
  });
});
