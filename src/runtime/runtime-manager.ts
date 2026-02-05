import { observable, makeObservable, action, computed } from 'mobx';
import { CompilationArtifacts } from './repl-manager';
import { WebGpuHostExecutor } from '../webgpu/webgpu-host-executor';
import { WebGpuHost } from '../webgpu/webgpu-host';
import { ResourceState, RuntimeValue } from '../webgpu/host-interface';
import { makeResourceStates } from './resources';
import { fetchAndDecodeImage } from '../utils/image-utils';

export type TransportState = 'playing' | 'paused' | 'stopped';

/**
 * Runtime Manager - orchestrates the execution loop and state.
 */
export class RuntimeManager {
  @observable
  public transportState: TransportState = 'stopped';

  @observable
  public currentCompiled: CompilationArtifacts | null = null;

  @observable
  public fps: number = 0;

  @observable
  public frameCount: number = 0;

  public device: GPUDevice | null = null;
  private host: WebGpuHost | null = null;
  private executor: WebGpuHostExecutor | null = null;
  private resources: Map<string, ResourceState> = new Map();
  private inputs: Map<string, RuntimeValue> = new Map();

  private lastFrameTime: number = 0;
  private frameId: number | null = null;
  private onFrameCallbacks: Set<(texture: GPUTexture) => void> = new Set();

  constructor() {
    makeObservable(this);
  }

  @action
  public async setCompiled(artifacts: CompilationArtifacts, device: GPUDevice | any) {
    this.currentCompiled = artifacts;
    this.device = device;
    this.resources = makeResourceStates(artifacts.ir);

    // [TEMP] Preload image inputs
    const testImage = await fetchAndDecodeImage('test.png');
    artifacts.ir.inputs.forEach(inp => {
      if (inp.type === 'texture2d') {
        const state = this.resources.get(inp.id);
        if (state) {
          state.width = testImage.width;
          state.height = testImage.height;
          state.data = testImage.data;
        }
      }
    });

    // We assume the device passed in is either a real GPUDevice or a mock
    // For now, let's keep it flexible.
    if (!artifacts.compiled.init) {
      throw new Error("Compiled artifacts missing init function");
    }

    await this.initHost(device, artifacts);
  }

  private async initHost(device: any, artifacts: CompilationArtifacts) {
    try {
      const gpuExecutor = await artifacts.compiled.init(device);
      this.host = new WebGpuHost({
        device: device,
        executor: gpuExecutor,
        resources: this.resources,
        logHandler: (msg, payload) => console.log(msg, payload),
      });

      this.executor = new WebGpuHostExecutor({
        ir: artifacts.ir,
        compiledCode: artifacts.compiled,
        host: this.host
      });
    } catch (e) {
      console.error("Runtime initialization failed:", e);
    }
  }

  @action
  public play() {
    if (this.transportState === 'playing') return;
    this.transportState = 'playing';
    this.lastFrameTime = performance.now();
    this.loop();
  }

  @action
  public pause() {
    this.transportState = 'paused';
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }

  @action
  public stop() {
    this.pause();
    this.transportState = 'stopped';
    this.frameCount = 0;
  }

  @action
  public step() {
    this.pause();
    this.executeFrame();
  }

  private loop = () => {
    if (this.transportState !== 'playing') return;

    this.executeFrame();
    this.frameId = requestAnimationFrame(this.loop);
  };

  private async executeFrame() {
    if (!this.executor || !this.host) return;

    const startTime = performance.now();

    try {
      // Execute the frame
      await this.executor.execute(this.inputs);
      this.frameCount++;

      // Calculate FPS
      const elapsed = startTime - this.lastFrameTime;
      if (elapsed > 0) {
        const instantFps = 1000 / elapsed;
        this.setFps(0.9 * this.fps + 0.1 * instantFps);
      }
      this.lastFrameTime = startTime;

      // Trigger callbacks with the primary output texture
      const tOutput = this.resources.get('t_output');
      if (tOutput && tOutput.gpuTexture) {
        this.onFrameCallbacks.forEach(cb => cb(tOutput.gpuTexture!));
      }
    } catch (e) {
      console.error("Frame execution error:", e);
      this.pause();
    }
  }

  @action
  private setFps(val: number) {
    this.fps = val;
  }

  public onNewFrame(cb: (texture: GPUTexture) => void) {
    this.onFrameCallbacks.add(cb);
    return () => this.onFrameCallbacks.delete(cb);
  }

  /**
   * Temporary input management
   */
  public setInput(id: string, value: RuntimeValue) {
    this.inputs.set(id, value);
  }

  public getResource(id: string): ResourceState | undefined {
    return this.resources.get(id);
  }
}
