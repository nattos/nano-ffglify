/**
 * Runtime Worker - owns a GPUDevice, runs JIT code, blits to OffscreenCanvas.
 */
import type { IRDocument } from '../ir/types';
import { makeResourceStates } from '../runtime/resources';
import { TestCardRenderer } from '../runtime/test-card-renderer';
import { WebGpuHost, IGpuExecutor } from '../webgpu/webgpu-host';
import { WebGpuHostExecutor } from '../webgpu/webgpu-host-executor';
import { CompiledTaskFunction, CompiledInitFunction } from '../webgpu/jit-types';
import { ResourceState, RuntimeValue } from '../webgpu/host-interface';
import { PATCH_SIZE } from '../constants';
import type {
  RuntimeWorkerRequest,
  RuntimeWorkerResponse,
  RuntimeInputEntryMsg,
} from './protocol';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let device: GPUDevice | null = null;
let offscreenCanvas: OffscreenCanvas | null = null;
let gpuContext: GPUCanvasContext | null = null;

let host: WebGpuHost | null = null;
let executor: WebGpuHostExecutor | null = null;
let resources: Map<string, ResourceState> = new Map();
let inputs: Map<string, RuntimeValue> = new Map();
let textureInputIds: string[] = [];
let testCardRenderer = new TestCardRenderer();
let testCardNumbers: Map<string, number> = new Map();
let testCardInputIds: Set<string> = new Set();

let playing = false;
let frameCount = 0;
let elapsedTime = 0;
let lastFrameTime = 0;
let fps = 0;

// Blit pipeline for rendering to OffscreenCanvas
let blitPipeline: GPURenderPipeline | null = null;
let blitUniformBuffer: GPUBuffer | null = null;
let blitSampler: GPUSampler | null = null;
let canvasWidth = 0;
let canvasHeight = 0;

// InputSources for texture uploads (simplified: no video support in worker)
let inputBitmaps: Map<string, ImageBitmap> = new Map();

// Current IR for getPrimaryOutputId
let currentIR: IRDocument | null = null;

// Blit pipeline for aspect-ratio scaling when uploading textures
let uploadBlitPipeline: GPURenderPipeline | null = null;
let uploadBlitSampler: GPUSampler | null = null;
let uploadBlitUniformBuffer: GPUBuffer | null = null;

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
self.onmessage = async (e: MessageEvent<RuntimeWorkerRequest>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'set-canvas':
        offscreenCanvas = msg.canvas;
        break;

      case 'resize-canvas':
        canvasWidth = Math.floor(msg.width * msg.dpr);
        canvasHeight = Math.floor(msg.height * msg.dpr);
        if (offscreenCanvas) {
          offscreenCanvas.width = canvasWidth;
          offscreenCanvas.height = canvasHeight;
        }
        break;

      case 'set-compiled':
        await handleSetCompiled(msg.ir, msg.finalInitCode, msg.finalTaskCode);
        break;

      case 'play':
        playing = true;
        break;

      case 'pause':
        playing = false;
        break;

      case 'stop':
        playing = false;
        frameCount = 0;
        elapsedTime = 0;
        lastFrameTime = 0;
        break;

      case 'step':
        playing = false;
        await executeFrame(performance.now());
        break;

      case 'tick':
        if (playing) {
          await executeFrame(msg.time);
        }
        break;

      case 'set-input': {
        inputs.set(msg.id, msg.value);
        break;
      }

      case 'set-texture-input': {
        // Stop test card animation for this slot
        testCardInputIds.delete(msg.id);
        inputBitmaps.set(msg.id, msg.bitmap);
        syncBitmapToGpu(msg.id, msg.bitmap);
        break;
      }

      case 'reset-texture-to-test-card': {
        inputBitmaps.delete(msg.id);
        testCardInputIds.add(msg.id);
        const resource = resources.get(msg.id);
        const number = testCardNumbers.get(msg.id) ?? 1;
        if (resource?.gpuTexture && device) {
          await testCardRenderer.render(device, resource.gpuTexture, number, elapsedTime);
        }
        break;
      }

      case 'capture-screenshot':
        await handleCaptureScreenshot();
        break;
    }
  } catch (err: any) {
    const response: RuntimeWorkerResponse = {
      type: 'error',
      message: err.message || String(err),
    };
    self.postMessage(response);
  }
};

// ---------------------------------------------------------------------------
// GPU Initialization
// ---------------------------------------------------------------------------
async function ensureDevice(): Promise<GPUDevice> {
  if (device) return device;
  const gpu = (self as any).navigator?.gpu;
  if (!gpu) throw new Error('WebGPU not available in worker');
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('No GPU adapter found');
  device = await adapter.requestDevice();
  return device!;
}

// ---------------------------------------------------------------------------
// set-compiled handler
// ---------------------------------------------------------------------------
async function handleSetCompiled(ir: IRDocument, finalInitCode: string, finalTaskCode: string) {
  try {
    const dev = await ensureDevice();
    currentIR = ir;

    // Reconstruct AsyncFunctions from code strings
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const init: CompiledInitFunction = new AsyncFunction('device', finalInitCode);
    const task: CompiledTaskFunction = new AsyncFunction('ctx', finalTaskCode);

    // Create resource states from IR
    resources = makeResourceStates(ir);

    // Allocate GPU textures
    resources.forEach((state, id) => {
      if (state.def.type === 'texture2d') {
        let width = PATCH_SIZE.width;
        let height = PATCH_SIZE.height;

        const sizeDef = state.def.size;
        if (sizeDef) {
          if (sizeDef.mode === 'fixed') {
            const val = (sizeDef as any).value;
            if (Array.isArray(val)) {
              width = val[0];
              height = val[1];
            } else {
              width = val;
              height = val;
            }
          } else if (sizeDef.mode === 'reference') {
            const refId = (sizeDef as any).ref;
            const ref = resources.get(refId);
            if (ref) {
              width = ref.width;
              height = ref.height;
            }
          }
        }

        state.width = width;
        state.height = height;
        state.gpuTexture = dev.createTexture({
          label: `Resource: ${id}`,
          size: [width, height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
                 GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
      }
    });

    // Map inputs
    textureInputIds = [];
    inputs.clear();
    testCardNumbers.clear();
    testCardInputIds.clear();

    const inputEntries: RuntimeInputEntryMsg[] = [];

    ir.inputs.forEach(inp => {
      const type = mapDataTypeToRuntimeType(inp.type);
      if (!type) return;

      const entry: RuntimeInputEntryMsg = {
        id: inp.id,
        type,
        label: inp.label || inp.id,
        currentValue: inp.default,
        defaultValue: inp.default,
        min: inp.ui?.min,
        max: inp.ui?.max,
      };

      if (inp.type === 'texture2d') {
        textureInputIds.push(inp.id);
        const textureIdx = textureInputIds.length - 1;
        const tcNumber = (textureIdx % 2) + 1;
        testCardNumbers.set(inp.id, tcNumber);
        testCardInputIds.add(inp.id);
        entry.currentValue = inp.id;
        inputs.set(inp.id, inp.id);
      } else if (inp.default !== undefined) {
        inputs.set(inp.id, inp.default);
      }

      inputEntries.push(entry);
    });

    // Render test cards
    for (const id of testCardInputIds) {
      const resource = resources.get(id);
      const number = testCardNumbers.get(id) ?? 1;
      if (resource?.gpuTexture) {
        await testCardRenderer.render(dev, resource.gpuTexture, number);
      }
    }

    // Initialize host & executor
    const gpuExecutor: IGpuExecutor = await init(dev);
    host = new WebGpuHost({
      device: dev,
      executor: gpuExecutor,
      resources,
      inputs,
      logHandler: (msg, payload) => console.log(msg, payload),
    });

    const compiledResult = { taskCode: '', initCode: '', finalTaskCode, finalInitCode: finalInitCode, task, init };
    executor = new WebGpuHostExecutor({
      ir,
      compiledCode: compiledResult,
      host,
    });

    // Reset frame state
    frameCount = 0;
    elapsedTime = 0;
    lastFrameTime = 0;
    fps = 0;

    const response: RuntimeWorkerResponse = {
      type: 'compiled-ok',
      inputEntries,
    };
    self.postMessage(response);
  } catch (err: any) {
    const response: RuntimeWorkerResponse = {
      type: 'compiled-error',
      message: err.message || String(err),
    };
    self.postMessage(response);
  }
}

// ---------------------------------------------------------------------------
// Frame execution
// ---------------------------------------------------------------------------
async function executeFrame(time: number) {
  if (!executor || !host || !device) return;

  const rawDeltaMs = lastFrameTime > 0 ? (time - lastFrameTime) : 0;
  const deltaTime = Math.min(rawDeltaMs / 1000, 0.1);
  elapsedTime += deltaTime;
  executor.setBuiltins({ time: elapsedTime, delta_time: deltaTime });

  try {
    // Re-render animated test cards
    if (testCardInputIds.size > 0) {
      for (const id of testCardInputIds) {
        const resource = resources.get(id);
        const number = testCardNumbers.get(id) ?? 1;
        if (resource?.gpuTexture) {
          await testCardRenderer.render(device, resource.gpuTexture, number, elapsedTime);
        }
      }
    }

    // Execute
    await executor.execute(inputs);
    frameCount++;

    // Calculate FPS
    const elapsed = time - lastFrameTime;
    if (elapsed > 0) {
      const instantFps = 1000 / elapsed;
      fps = 0.9 * fps + 0.1 * instantFps;
    }
    lastFrameTime = time;

    // Blit primary output to OffscreenCanvas
    blitToCanvas();

    const response: RuntimeWorkerResponse = {
      type: 'frame',
      frameCount,
      fps,
    };
    self.postMessage(response);
  } catch (err: any) {
    playing = false;
    const response: RuntimeWorkerResponse = {
      type: 'error',
      message: `Frame error: ${err.message || String(err)}`,
    };
    self.postMessage(response);
  }
}

// ---------------------------------------------------------------------------
// Blit to OffscreenCanvas
// ---------------------------------------------------------------------------
function blitToCanvas() {
  if (!offscreenCanvas || !device) return;

  const outputId = getPrimaryOutputId();
  if (!outputId) return;
  const outputRes = resources.get(outputId);
  if (!outputRes?.gpuTexture) return;

  if (!gpuContext) {
    gpuContext = offscreenCanvas.getContext('webgpu') as GPUCanvasContext;
    if (!gpuContext) return;
    gpuContext.configure({
      device,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
    });
  }

  if (!blitPipeline) {
    initBlitPipeline(device);
  }

  if (!blitPipeline || !blitUniformBuffer) return;

  const srcTexture = outputRes.gpuTexture;
  const sw = offscreenCanvas.width;
  const sh = offscreenCanvas.height;
  const tw = srcTexture.width;
  const th = srcTexture.height;

  const sRatio = sw / sh;
  const tRatio = tw / th;
  let scaleX = 1.0;
  let scaleY = 1.0;
  if (tRatio > sRatio) {
    scaleY = sRatio / tRatio;
  } else {
    scaleX = tRatio / sRatio;
  }

  const params = new Float32Array([scaleX, scaleY, 0, 0, sw, sh, tw, th]);
  device.queue.writeBuffer(blitUniformBuffer, 0, params);

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginRenderPass({
    colorAttachments: [{
      view: gpuContext.getCurrentTexture().createView(),
      clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1 },
      loadOp: 'clear' as GPULoadOp,
      storeOp: 'store' as GPUStoreOp,
    }],
  });

  const bindGroup = device.createBindGroup({
    layout: blitPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTexture.createView() },
      { binding: 1, resource: { buffer: blitUniformBuffer } },
    ],
  });

  passEncoder.setPipeline(blitPipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.draw(4);
  passEncoder.end();
  device.queue.submit([commandEncoder.finish()]);
}

function initBlitPipeline(dev: GPUDevice) {
  const shaderCode = `
    struct Params {
      scale: vec2<f32>,
      offset: vec2<f32>,
      screenSize: vec2<f32>,
      texSize: vec2<f32>,
    }
    @group(0) @binding(1) var<uniform> params: Params;

    @vertex
    fn vert_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
      var pos = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, 1.0)
      );
      return vec4<f32>(pos[vertexIndex] * params.scale + params.offset, 0.0, 1.0);
    }

    @group(0) @binding(0) var t_src: texture_2d<f32>;

    @fragment
    fn frag_main(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
      let gridSize = 16.0;
      let grid = floor(fragPos.xy / gridSize);
      let checker = (i32(grid.x) + i32(grid.y)) % 2;
      let bgColor = select(vec4<f32>(0.15, 0.15, 0.15, 1.0), vec4<f32>(0.2, 0.2, 0.2, 1.0), checker == 0);

      let quadOrigin = (params.screenSize - params.screenSize * params.scale) * 0.5;
      let quadSize = params.screenSize * params.scale;
      let posInQuad = fragPos.xy - quadOrigin;
      let texCoord = vec2<i32>(floor(posInQuad * params.texSize / quadSize));
      let clamped = clamp(texCoord, vec2<i32>(0), vec2<i32>(params.texSize) - 1);
      let srcColor = textureLoad(t_src, clamped, 0);

      return mix(bgColor, srcColor, srcColor.a);
    }
  `;

  const module = dev.createShaderModule({ code: shaderCode });
  blitPipeline = dev.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vert_main' },
    fragment: {
      module,
      entryPoint: 'frag_main',
      targets: [{ format: 'bgra8unorm' }],
    },
    primitive: { topology: 'triangle-strip' },
  });

  blitUniformBuffer = dev.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

// ---------------------------------------------------------------------------
// Texture upload (from ImageBitmap)
// ---------------------------------------------------------------------------
function syncBitmapToGpu(id: string, bitmap: ImageBitmap) {
  if (!device) return;

  const resource = resources.get(id);
  if (!resource?.gpuTexture) return;

  const width = bitmap.width;
  const height = bitmap.height;

  const tempTex = device.createTexture({
    label: `TempUpload: ${id}`,
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING |
           GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture: tempTex },
    [width, height],
  );

  blitTextureToResource(device, tempTex, resource.gpuTexture);
  tempTex.destroy();
}

function blitTextureToResource(dev: GPUDevice, src: GPUTexture, dst: GPUTexture) {
  if (!uploadBlitPipeline) {
    initUploadBlitPipeline(dev);
  }
  if (!uploadBlitPipeline || !uploadBlitSampler || !uploadBlitUniformBuffer) return;

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
  dev.queue.writeBuffer(uploadBlitUniformBuffer, 0, params);

  const commandEncoder = dev.createCommandEncoder();
  const passEncoder = commandEncoder.beginRenderPass({
    colorAttachments: [{
      view: dst.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: 'clear' as GPULoadOp,
      storeOp: 'store' as GPUStoreOp,
    }],
  });

  const bindGroup = dev.createBindGroup({
    layout: uploadBlitPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: src.createView() },
      { binding: 1, resource: uploadBlitSampler },
      { binding: 2, resource: { buffer: uploadBlitUniformBuffer } },
    ],
  });

  passEncoder.setPipeline(uploadBlitPipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.draw(4);
  passEncoder.end();
  dev.queue.submit([commandEncoder.finish()]);
}

function initUploadBlitPipeline(dev: GPUDevice) {
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

  const module = dev.createShaderModule({ code: shaderCode });
  uploadBlitPipeline = dev.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vert_main' },
    fragment: {
      module,
      entryPoint: 'frag_main',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: { topology: 'triangle-strip' },
  });
  uploadBlitSampler = dev.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });
  uploadBlitUniformBuffer = dev.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------
async function handleCaptureScreenshot() {
  if (!device) {
    const response: RuntimeWorkerResponse = { type: 'error', message: 'No GPU device' };
    self.postMessage(response);
    return;
  }

  const outputId = getPrimaryOutputId();
  if (!outputId) {
    const response: RuntimeWorkerResponse = { type: 'error', message: 'No output texture' };
    self.postMessage(response);
    return;
  }

  const outputRes = resources.get(outputId);
  if (!outputRes?.gpuTexture) {
    const response: RuntimeWorkerResponse = { type: 'error', message: 'No GPU texture for output' };
    self.postMessage(response);
    return;
  }

  const tex = outputRes.gpuTexture;
  const width = tex.width;
  const height = tex.height;
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const bufferSize = bytesPerRow * height;

  const readBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const commandEncoder = device.createCommandEncoder();
  commandEncoder.copyTextureToBuffer(
    { texture: tex },
    { buffer: readBuffer, bytesPerRow, rowsPerImage: height },
    [width, height],
  );
  device.queue.submit([commandEncoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const mapped = readBuffer.getMappedRange();
  // Remove row padding
  const pixels = new Uint8Array(width * height * 4);
  const src = new Uint8Array(mapped);
  for (let row = 0; row < height; row++) {
    pixels.set(src.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
  }
  readBuffer.unmap();
  readBuffer.destroy();

  const response: RuntimeWorkerResponse = {
    type: 'screenshot',
    pixels: pixels.buffer,
    width,
    height,
  };
  self.postMessage(response, { transfer: [pixels.buffer] });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getPrimaryOutputId(): string | null {
  if (!currentIR) return null;

  // 1. Prefer explicit output flag
  for (const [id, res] of resources) {
    if (res.def.isOutput && res.def.type === 'texture2d') return id;
  }

  // 2. Prefer explicit output names
  const candidates = ['t_output', 'output_tex', 'out_tex', 't_out'];
  for (const id of candidates) {
    if (resources.has(id)) return id;
  }

  // 3. Fallback to last texture2d resource
  let lastTexResId: string | null = null;
  for (const [id, res] of resources) {
    if (res.def.type === 'texture2d') lastTexResId = id;
  }
  if (lastTexResId) return lastTexResId;

  // 4. Fallback to last texture input
  if (textureInputIds.length > 0) {
    return textureInputIds[textureInputIds.length - 1];
  }

  return null;
}

function mapDataTypeToRuntimeType(type: string): string | null {
  switch (type) {
    case 'texture2d': return 'texture';
    case 'bool': return 'bool';
    case 'int': return 'int';
    case 'float': return 'float';
    case 'float2': return 'float2';
    case 'float3': return 'float3';
    case 'float4': return 'float4';
    default: return null;
  }
}

// Post ready
const readyMsg: RuntimeWorkerResponse = { type: 'ready' };
self.postMessage(readyMsg);
