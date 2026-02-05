import { RuntimeManager } from '../../runtime/runtime-manager';
import { CompilationArtifacts } from '../../runtime/repl-manager';
import * as imageUtils from '../../utils/image-utils';

vi.mock('../../utils/image-utils', () => ({
  fetchAndDecodeImage: vi.fn(() => Promise.resolve({
    data: [[0, 0, 0, 1]],
    width: 1,
    height: 1
  }))
}));

describe('RuntimeManager', () => {
  let runtimeManager: RuntimeManager;

  beforeEach(() => {
    vi.useFakeTimers();
    runtimeManager = new RuntimeManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const mockArtifacts: CompilationArtifacts = {
    ir: {
      version: '1.0',
      meta: { name: 'Test' },
      entryPoint: 'main',
      functions: [],
      inputs: [],
      resources: [
        {
          id: 't_output',
          type: 'texture2d',
          size: { mode: 'fixed', value: [100, 100] },
          persistence: { retain: true, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
        }
      ],
      structs: []
    },
    compiled: {
      init: async (device: any) => ({
        executeShader: vi.fn(),
        executeDraw: vi.fn(),
        executeSyncToCpu: vi.fn(),
        executeWaitCpuSync: vi.fn()
      }),
      task: async () => 0
    },
    wgsl: {}
  };

  it('should initialize correctly', async () => {
    const mockDevice = {};
    await runtimeManager.setCompiled({ ...mockArtifacts }, mockDevice);
    expect(runtimeManager.currentCompiled).toBeDefined();
    expect(runtimeManager.transportState).toBe('stopped');
    expect(runtimeManager.getResource('t_output')).toBeDefined();
  });

  it('should play, pause, and stop', async () => {
    const mockDevice = {};
    await runtimeManager.setCompiled({ ...mockArtifacts }, mockDevice);

    runtimeManager.play();
    expect(runtimeManager.transportState).toBe('playing');

    runtimeManager.pause();
    expect(runtimeManager.transportState).toBe('paused');

    runtimeManager.stop();
    expect(runtimeManager.transportState).toBe('stopped');
    expect(runtimeManager.frameCount).toBe(0);
  });

  it('should increment frameCount when playing', async () => {
    const mockDevice = {};
    await runtimeManager.setCompiled({ ...mockArtifacts }, mockDevice);

    runtimeManager.play();

    // Simulate a few frames
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(16);

    expect(runtimeManager.frameCount).toBeGreaterThan(0);
    runtimeManager.stop();
  });

  it('should trigger frame callbacks', async () => {
    const mockDevice = {};
    await runtimeManager.setCompiled({ ...mockArtifacts }, mockDevice);

    const res = runtimeManager.getResource('t_output');
    const mockTex = { id: 'mock-tex' };
    if (res) {
      res.gpuTexture = mockTex as any;
    }

    const callback = vi.fn();
    runtimeManager.onNewFrame(callback);

    runtimeManager.play();
    await vi.advanceTimersByTimeAsync(16);

    expect(callback).toHaveBeenCalledWith(mockTex);
    runtimeManager.stop();
  });
});
