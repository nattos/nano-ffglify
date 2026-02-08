import { observable, makeObservable, action, computed, runInAction } from 'mobx';
import { CompilationArtifacts } from './repl-manager';
import { WebGpuHostExecutor } from '../webgpu/webgpu-host-executor';
import { WebGpuHost } from '../webgpu/webgpu-host';
import { ResourceState, RuntimeValue } from '../webgpu/host-interface';
import { makeResourceStates } from './resources';
import { PATCH_SIZE } from '../constants';

export type TransportState = 'playing' | 'paused' | 'stopped';

export type TextureSourceType = 'url' | 'file';

export interface TextureSource {
  type: TextureSourceType;
  value: string | File;
}

interface InputSourceState {
  id: string;
  source: TextureSource;
  videoElement?: HTMLVideoElement;
  loadedImage?: VideoFrame;
  isDirty: boolean;
  isLoading: boolean;
}

export enum RuntimeInputType {
  Texture = 'texture',
  Bool = 'bool',
  Int = 'int',
  Float = 'float',
  Float2 = 'float2',
  Float3 = 'float3',
  Float4 = 'float4',
}

export interface RuntimeInputEntry {
  id: string;
  type: RuntimeInputType;
  label: string;
  currentValue: any;
  defaultValue: any;
  min?: number;
  max?: number;
  displayText?: string; // High-level metadata (e.g. filename for textures)
}

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
  private inputSources: Map<string, InputSourceState> = new Map();
  private textureInputIds: string[] = [];

  @observable
  public inputEntries: Map<string, RuntimeInputEntry> = new Map();

  private lastFrameTime: number = 0;
  private frameId: number | null = null;
  private onFrameCallbacks: Set<(texture: GPUTexture) => void> = new Set();

  private blitPipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private blitUniformBuffer: GPUBuffer | null = null;

  constructor() {
    makeObservable(this);
  }

  public async setCompiled(artifacts: CompilationArtifacts, device: GPUDevice) {
    this.device = device;

    // Initialize Blit Pipeline if we have a real device
    if (device) {
      if (!this.blitPipeline) {
        this.initBlitPipeline(device);
      }
    }

    const ir = artifacts.ir;

    runInAction(() => {
      this.currentCompiled = artifacts;
      this.resources = makeResourceStates(ir);

      // 1. Allocate all textures
      this.resources.forEach((state, id) => {
        if (state.def.type === 'texture2d') {
          // Default to PATCH_SIZE if viewport mode or not fixed
          const isViewport = state.def.size?.mode === 'viewport';
          const width = isViewport ? PATCH_SIZE.width : state.width;
          const height = isViewport ? PATCH_SIZE.height : state.height;

          state.width = width;
          state.height = height;

          state.gpuTexture = device.createTexture({
            label: `Resource: ${id}`,
            size: [width, height],
            format: 'rgba8unorm', // Standard format for our internal patches
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
          });
        }
      });

      // 2. Map inputs and apply defaults
      this.textureInputIds = [];
      this.inputEntries.clear();

      ir.inputs.forEach(inp => {
        const type = this.mapDataTypeToRuntimeType(inp.type);
        if (!type) return;

        const entry: RuntimeInputEntry = {
          id: inp.id,
          type,
          label: inp.label || inp.id,
          currentValue: inp.default,
          defaultValue: inp.default,
          min: inp.ui?.min,
          max: inp.ui?.max,
        };

        if (inp.type === 'texture2d') {
          this.textureInputIds.push(inp.id);
          // Initialize with test.png if not already set
          if (!this.inputSources.has(inp.id)) {
            this.setTextureSource(inp.id, { type: 'url', value: 'test.png' });
          }
          entry.currentValue = inp.id; // The resource ID
          this.inputs.set(inp.id, inp.id);
        } else if (inp.default !== undefined) {
          this.inputs.set(inp.id, inp.default);
        }

        this.inputEntries.set(inp.id, entry);
      });
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
      // Sync dynamic inputs
      this.syncInputsToGpu();

      // Execute the frame
      await this.executor.execute(this.inputs);
      runInAction(() => {
        this.frameCount++;
      });

      // Calculate FPS
      const elapsed = startTime - this.lastFrameTime;
      if (elapsed > 0) {
        const instantFps = 1000 / elapsed;
        this.setFps(0.9 * this.fps + 0.1 * instantFps);
      }
      this.lastFrameTime = startTime;

      // Trigger callbacks with the primary output texture
      const outputId = this.getPrimaryOutputId();
      const tOutput = outputId ? this.resources.get(outputId) : null;
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

  private initBlitPipeline(device: GPUDevice) {
    const shaderCode = `
            struct Params {
                scale: vec2<f32>,
                offset: vec2<f32>,
            }
            @group(0) @binding(2) var<uniform> params: Params;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
            }

            @vertex
            fn vert_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                var pos = array<vec2<f32>, 4>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>(1.0, -1.0),
                    vec2<f32>(-1.0, 1.0),
                    vec2<f32>(1.0, 1.0)
                );
                var uv = array<vec2<f32>, 4>(
                    vec2<f32>(0.0, 1.0),
                    vec2<f32>(1.0, 1.0),
                    vec2<f32>(0.0, 0.0),
                    vec2<f32>(1.0, 0.0)
                );
                var out: VertexOutput;
                out.position = vec4<f32>(pos[vertexIndex] * params.scale + params.offset, 0.0, 1.0);
                out.uv = uv[vertexIndex];
                return out;
            }

            @group(0) @binding(0) var t_src: texture_2d<f32>;
            @group(0) @binding(1) var s_src: sampler;

            @fragment
            fn frag_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
                return textureSample(t_src, s_src, uv);
            }
        `;

    const module = device.createShaderModule({ code: shaderCode });
    this.blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vert_main' },
      fragment: {
        module,
        entryPoint: 'frag_main',
        targets: [{ format: 'rgba8unorm' }]
      },
      primitive: { topology: 'triangle-strip' }
    });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.blitUniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  private blitTexture(device: GPUDevice, src: GPUTexture, dst: GPUTexture) {
    if (!this.blitPipeline || !this.sampler || !this.blitUniformBuffer) return;

    const sw = dst.width;
    const sh = dst.height;
    const tw = src.width;
    const th = src.height;

    const sRatio = sw / sh;
    const tRatio = tw / th;

    let scaleX = 1.0;
    let scaleY = 1.0;

    if (tRatio > sRatio) {
      scaleY = sRatio / tRatio;
    } else {
      scaleX = tRatio / sRatio;
    }

    const params = new Float32Array([scaleX, scaleY, 0, 0]);
    device.queue.writeBuffer(this.blitUniformBuffer, 0, params);

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: dst.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }]
    });

    const bindGroup = device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.blitUniformBuffer } }
      ]
    });

    passEncoder.setPipeline(this.blitPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(4);
    passEncoder.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  public setTextureSource(id: string, source: TextureSource) {
    let state = this.inputSources.get(id);
    if (!state) {
      state = { id, source, isDirty: true, isLoading: false };
      this.inputSources.set(id, state);
    } else {
      state.source = source;
      state.isDirty = true;
      // Clean up previous
      if (state.videoElement) {
        state.videoElement.pause();
        state.videoElement.src = "";
        state.videoElement.load();
        state.videoElement = undefined;
      }
      if (state.loadedImage) {
        state.loadedImage.close();
        state.loadedImage = undefined;
      }
    }
    this.loadSource(state);

    // Sync entry displayText
    const entry = this.inputEntries.get(id);
    if (entry) {
      entry.displayText = typeof source.value === 'string' ? source.value : source.value.name;
    }
  }

  private async loadSource(state: InputSourceState) {
    state.isLoading = true;
    try {
      if (state.source.type === 'url') {
        const url = state.source.value as string;
        if (url.match(/\.(mp4|webm|ogg|mov)$/i)) {
          state.videoElement = this.createVideoElement(url);
        } else {
          const response = await fetch(url);
          // @ts-ignore
          const decoder = new ImageDecoder({ data: response.body, type: 'image/png' });
          const { image } = await decoder.decode();
          state.loadedImage = image;
          state.isDirty = true;
          decoder.close();
        }
      } else {
        const file = state.source.value as File;
        if (file.type.startsWith('video/')) {
          const url = URL.createObjectURL(file);
          state.videoElement = this.createVideoElement(url);
        } else {
          // @ts-ignore
          const decoder = new ImageDecoder({ data: file.stream(), type: file.type });
          const { image } = await decoder.decode();
          state.loadedImage = image;
          state.isDirty = true;
          decoder.close();
        }
      }
    } catch (e) {
      console.error(`Failed to load source for ${state.id}:`, e);
    } finally {
      state.isLoading = false;
    }
  }

  private createVideoElement(url: string): HTMLVideoElement {
    const video = document.createElement('video');
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.play();
    return video;
  }

  private syncInputsToGpu() {
    if (!this.device) return;

    for (const state of this.inputSources.values()) {
      const resource = this.resources.get(state.id);
      if (!resource || !resource.gpuTexture) continue;

      let sourceObject: any = null;
      let isVideo = false;

      if (state.videoElement && state.videoElement.readyState >= 2) {
        sourceObject = state.videoElement;
        isVideo = true;
      } else if (state.loadedImage) {
        sourceObject = state.loadedImage;
      }

      if (sourceObject && (state.isDirty || isVideo)) {
        const width = (sourceObject as any).displayWidth ?? (sourceObject as any).videoWidth ?? (sourceObject as any).width;
        const height = (sourceObject as any).displayHeight ?? (sourceObject as any).videoHeight ?? (sourceObject as any).height;

        const tempTex = this.device.createTexture({
          label: `TempUpload: ${state.id}`,
          size: [width, height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
        });

        this.device.queue.copyExternalImageToTexture(
          { source: sourceObject },
          { texture: tempTex },
          [width, height]
        );

        this.blitTexture(this.device, tempTex, resource.gpuTexture);
        tempTex.destroy();
        state.isDirty = false;
      }
    }
  }

  public onNewFrame(cb: (texture: GPUTexture) => void) {
    this.onFrameCallbacks.add(cb);
    return () => this.onFrameCallbacks.delete(cb);
  }

  @action
  public setInput(id: string, value: RuntimeValue) {
    this.inputs.set(id, value);
    const entry = this.inputEntries.get(id);
    if (entry) {
      entry.currentValue = value;
    }
  }

  private mapDataTypeToRuntimeType(type: string): RuntimeInputType | null {
    switch (type) {
      case 'texture2d': return RuntimeInputType.Texture;
      case 'bool': return RuntimeInputType.Bool;
      case 'int': return RuntimeInputType.Int;
      case 'float': return RuntimeInputType.Float;
      case 'float2': return RuntimeInputType.Float2;
      case 'float3': return RuntimeInputType.Float3;
      case 'float4': return RuntimeInputType.Float4;
      default: return null;
    }
  }

  public getResource(id: string): ResourceState | undefined {
    return this.resources.get(id);
  }

  public getTextureInputIds(): string[] {
    return this.textureInputIds;
  }

  /**
   * Identifies the primary output texture for the UI.
   */
  public getPrimaryOutputId(): string | null {
    // 1. Prefer explicit output names
    const candidates = ['t_output', 'output_tex', 'out_tex', 't_out'];
    for (const id of candidates) {
      if (this.resources.has(id)) return id;
    }

    // 2. Fallback to the last texture2d resource
    let lastTexResId: string | null = null;
    this.resources.forEach((res, id) => {
      if (res.def.type === 'texture2d') {
        lastTexResId = id;
      }
    });
    if (lastTexResId) return lastTexResId;

    // 3. Fallback to the last texture input
    if (this.textureInputIds.length > 0) {
      return this.textureInputIds[this.textureInputIds.length - 1];
    }

    return null;
  }
}
