import { observable, makeObservable, action, computed, runInAction } from 'mobx';
import { CompilationArtifacts } from './repl-manager';
import { WebGpuHostExecutor } from '../webgpu/webgpu-host-executor';
import { WebGpuHost } from '../webgpu/webgpu-host';
import { ResourceState, RuntimeValue } from '../webgpu/host-interface';
import { makeResourceStates } from './resources';
import { PATCH_SIZE } from '../constants';

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

    // 1. Fetch and decode image using WebCodecs (ImageDecoder)
    const response = await fetch('test.png');
    if (!response.body) throw new Error("Failed to fetch test.png");

    // @ts-ignore - ImageDecoder might not be in all type definitions yet
    const decoder = new ImageDecoder({ data: response.body, type: 'image/png' });
    const { image } = await decoder.decode();

    const ir = artifacts.ir;

    runInAction(() => {
      this.currentCompiled = artifacts;
      this.resources = makeResourceStates(ir);

      // 2. Allocate all textures at PATCH_SIZE
      this.resources.forEach((state, id) => {
        if (state.def.type === 'texture2d') {
          state.width = PATCH_SIZE.width;
          state.height = PATCH_SIZE.height;

          state.gpuTexture = device.createTexture({
            label: `Resource: ${id}`,
            size: [PATCH_SIZE.width, PATCH_SIZE.height],
            format: 'rgba8unorm', // Standard format for our internal patches
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
          });
        }
      });

      // 3. Map inputs and apply defaults
      ir.inputs.forEach(inp => {
        if (inp.type === 'texture2d') {
          const state = this.resources.get(inp.id);
          if (state && image) {
            // Upload source image to a temp texture using GPU queue
            const tempTex = device.createTexture({
              label: `Temp: ${inp.id}`,
              size: [image.displayWidth, image.displayHeight],
              format: 'rgba8unorm',
              usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
            });

            device.queue.copyExternalImageToTexture(
              { source: image },
              { texture: tempTex },
              [image.displayWidth, image.displayHeight]
            );

            // Blit and fit into our patch texture
            if (state.gpuTexture) {
              this.blitTexture(device, tempTex, state.gpuTexture);
            }
            tempTex.destroy();
          }
          this.inputs.set(inp.id, inp.id);
        } else if (inp.default !== undefined) {
          this.inputs.set(inp.id, inp.default);
        }
      });

      image.close();
      decoder.close();
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
