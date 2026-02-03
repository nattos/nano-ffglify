import { FunctionDef, ResourceDef, StructDef, TextureFormat } from '../ir/types';
import { RuntimeValue, ResourceState } from '../ir/resource-store';
import { BuiltinOp, TextureFormatFromId, RenderPipelineDef } from '../ir/types';
import { WgslGenerator, CompilationMetadata } from './wgsl-generator';
import { GpuCache } from './gpu-cache';
import { ShaderLayout, packBuffer } from './shader-layout';

/**
 * WebGPU Executor
 * Directly handles WebGPU resource management and shader execution.
 */
export class WebGpuExecutor {
  device: GPUDevice;
  resources: Map<string, ResourceState>;
  inputs: Map<string, RuntimeValue>;

  private activePipelines: Map<string, { pipeline: GPUComputePipeline, metadata: CompilationMetadata }> = new Map();
  private activeRenderPipelines: Map<string, { pipeline: GPURenderPipeline, metadata: CompilationMetadata }> = new Map();
  private allFunctions: FunctionDef[] = [];
  private allStructs: StructDef[] = [];

  constructor(device: GPUDevice, resources: Map<string, ResourceState>, inputs: Map<string, RuntimeValue>) {
    this.device = device;
    this.resources = resources;
    this.inputs = inputs;
  }

  destroy() {
    this.activePipelines.clear();
    this.activeRenderPipelines.clear();
  }

  /**
   * Pre-compile all shaders in the IR document.
   */
  async initialize(functions: FunctionDef[], allResources: ResourceDef[], structs: StructDef[] = []) {
    this.allFunctions = functions;
    this.allStructs = structs;
    const generator = new WgslGenerator();

    // Identify shader stages
    const computeShaders = new Set<string>();
    const renderShaders = new Set<string>();

    console.log(`[WebGpuExecutor] Initializing with ${functions.length} functions and ${allResources.length} resources`);

    for (const f of functions) {
      if (f.type !== 'cpu') continue;
      for (const node of f.nodes) {
        if (node.op === 'cmd_dispatch' && node.func) {
          computeShaders.add(node.func);
        }
        if (node.op === 'cmd_draw') {
          if (node.vertex) renderShaders.add(node.vertex);
          if (node.fragment) renderShaders.add(node.fragment);
        }
      }
    }

    for (const func of functions) {
      if (func.type !== 'shader') continue;

      const isCompute = computeShaders.has(func.id) || (!renderShaders.has(func.id));
      if (!isCompute) continue;

      // Options for compilation
      const options: any = {
        inputBinding: 1,
        resourceBindings: new Map<string, number>(),
        resourceDefs: new Map<string, ResourceDef>(),
        stage: 'compute'
      };

      // Collect ALL resources including texture-inputs that were promoted to resources in context
      let bindingIdx = 2;
      this.resources.forEach((state, id) => {
        options.resourceBindings!.set(id, bindingIdx++);
        options.resourceDefs!.set(id, state.def);
      });

      const result = generator.compileFunctions(functions, func.id, options, { structs });
      // console.log(`[WebGpuExecutor] Generated WGSL for ${func.id}:\n${result.code}`);

      try {
        const pipeline = await GpuCache.getComputePipeline(this.device, result.code);
        this.activePipelines.set(func.id, { pipeline, metadata: result.metadata });
      } catch (e: any) {
        console.warn(`[WebGpuExecutor] Failed to pre-compile compute pipeline for ${func.id}: ${e.message}`);
      }
    }
  }

  /**
   * Execute a "Compute" function on the GPU.
   */
  async executeShader(func: FunctionDef, workgroups: [number, number, number], args: Record<string, RuntimeValue> = {}) {
    const funcId = func.id;

    // 1. Get Pipeline & Metadata
    const entry = this.activePipelines.get(funcId);
    if (!entry) {
      throw new Error(`[WebGpuExecutor] No pre-compiled pipeline for ${funcId}`);
    }
    const { pipeline, metadata } = entry;

    // 2. Prepare Inputs Buffer
    let bindGroup: GPUBindGroup | undefined;
    const nonBuiltinInputs = func.inputs.filter(i => !i.builtin && i.type !== 'texture2d' && i.type !== 'texture_2d');

    // Inject dispatch size for bounds checking
    console.log(`[Executor] Injecting dispatch size: ${JSON.stringify(workgroups)}`);
    nonBuiltinInputs.push({ id: 'u_dispatch_size', type: 'vec3<u32>' } as any);
    args['u_dispatch_size'] = [workgroups[0], workgroups[1], workgroups[2]];

    const layout = new ShaderLayout(this.allStructs);
    // Use calculateBlockLayout with sort=true to match WgslGenerator's (emulated) behavior
    // Use std430 for inputs (storage buffer)
    const inputLayout = layout.calculateBlockLayout(nonBuiltinInputs, true, 'std430');

    const entries: GPUBindGroupEntry[] = [];
    const stagingBuffers: { id: string, staging: GPUBuffer, isTexture?: boolean }[] = [];
    let inputBuffer: GPUBuffer | undefined;

    if (inputLayout.fields.length > 0) {
      console.log(`[Executor] Packing inputs with layout: ${JSON.stringify(inputLayout.fields)}`);
      // Use packBuffer from shader-layout
      const bufferData = packBuffer(inputLayout, args, layout, 'std430');
      const usage = (globalThis as any).GPUBufferUsage.STORAGE;

      inputBuffer = this.device.createBuffer({
        label: `${funcId}_inputs`,
        size: bufferData.byteLength,
        usage: usage | (globalThis as any).GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(inputBuffer, 0, bufferData);

      if (metadata.inputBinding !== undefined) {
        entries.push({ binding: metadata.inputBinding, resource: { buffer: inputBuffer } });
      }
    }

    // 3. Create BindGroup using compiled metadata
    metadata.resourceBindings.forEach((binding, resId) => {
      console.log(`[Executor] Processing binding for ${resId} at ${binding}`);
      const state = this.resources.get(resId);
      if (!state) return;

      const res = state.def;
      if (res.type === 'texture2d') {
        const tex = this.ensureTexture(res.id);
        if (tex) {
          this.writeTextureData(res.id);
          entries.push({ binding, resource: tex.createView() });
        }
      } else {
        const compCount = layout.getComponentCount(res.dataType || 'float');
        const finalSize = Math.max(state.width * compCount * 4, 16);
        // console.log(`[WebGpuExecutor] Creating buffer ${resId}. Width: ${state.width}, Comp: ${compCount}, Size: ${finalSize}`);

        if ((state as any).gpuBuffer && (state as any).gpuBuffer.size < finalSize) {
          (state as any).gpuBuffer.destroy();
          (state as any).gpuBuffer = undefined;
        }

        if (!(state as any).gpuBuffer) {
          (state as any).gpuBuffer = this.device.createBuffer({
            label: res.id,
            size: finalSize,
            usage: (globalThis as any).GPUBufferUsage.STORAGE | (globalThis as any).GPUBufferUsage.COPY_SRC | (globalThis as any).GPUBufferUsage.COPY_DST
          });
        }
        if (state.data) {
          const flat = (state.data as any).flat(2) as number[];
          this.device.queue.writeBuffer((state as any).gpuBuffer, 0, new Float32Array(flat));
        }
        entries.push({ binding, resource: { buffer: (state as any).gpuBuffer } });
      }
    });

    if (entries.length > 0) {
      bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries
      });
    }

    // 4. Dispatch
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    if (bindGroup) pass.setBindGroup(0, bindGroup);

    // Calculate dispatch dimensions based on metadata workgroup size
    const dx = Math.ceil(workgroups[0] / metadata.workgroupSize[0]);
    const dy = Math.ceil(workgroups[1] / metadata.workgroupSize[1]);
    const dz = Math.ceil(workgroups[2] / metadata.workgroupSize[2]);
    pass.dispatchWorkgroups(dx, dy, dz);
    pass.end();

    this.device.queue.submit([encoder.finish()]);

    // [DEBUG] Automatic read-back for development.
    // In production, syncResults or readbackResource should be called explicitly.
    await this.syncResults(Array.from(this.resources.keys()));
  }

  /**
   * [DEBUG] Sync results from GPU to CPU ResourceState.
   */
  private async syncResults(resourceIds: string[]) {
    const encoder = this.device.createCommandEncoder();
    const stagingBuffers: { id: string, staging: GPUBuffer, isTexture?: boolean }[] = [];

    resourceIds.forEach(id => {
      const state = this.resources.get(id);
      if (!state) return;

      const res = state.def;
      if (res.type === 'texture2d') {
        const gpuTexture = (state as any).gpuTexture as GPUTexture;
        if (gpuTexture) {
          const irFormat = (state.def.format || 'rgba8').toString().toLowerCase();
          const isFloat = irFormat.includes('32f') || irFormat.includes('16f') || irFormat.includes('float');
          const bytesPerChannel = isFloat ? 4 : 1;
          const bytesPerRow = Math.ceil((state.width * 4 * bytesPerChannel) / 256) * 256;
          const staging = this.device.createBuffer({
            size: bytesPerRow * state.height,
            usage: (globalThis as any).GPUBufferUsage.MAP_READ | (globalThis as any).GPUBufferUsage.COPY_DST
          });
          encoder.copyTextureToBuffer({ texture: gpuTexture }, { buffer: staging, bytesPerRow }, [state.width, state.height, 1]);
          stagingBuffers.push({ id, staging, isTexture: true });
        }
      } else {
        const gpuBuffer = (state as any).gpuBuffer as GPUBuffer;
        if (gpuBuffer) {
          const staging = this.device.createBuffer({
            size: gpuBuffer.size,
            usage: (globalThis as any).GPUBufferUsage.MAP_READ | (globalThis as any).GPUBufferUsage.COPY_DST
          });
          encoder.copyBufferToBuffer(gpuBuffer, 0, staging, 0, gpuBuffer.size);
          stagingBuffers.push({ id, staging });
        }
      }
    });

    this.device.queue.submit([encoder.finish()]);

    await Promise.all(stagingBuffers.map(async ({ id, staging, isTexture }) => {
      await staging.mapAsync((globalThis as any).GPUMapMode.READ);
      const state = this.resources.get(id);
      if (state) {
        const mapped = staging.getMappedRange();
        if (isTexture) {
          const irFormat = (state.def.format || 'rgba8').toString().toLowerCase();
          const isFloat = irFormat.includes('32f') || irFormat.includes('16f') || irFormat.includes('float');
          const bytesPerChannel = isFloat ? 4 : 1;
          const bytesPerRow = Math.ceil((state.width * 4 * bytesPerChannel) / 256) * 256;
          const reshaped = [];

          if (isFloat) {
            const data = new Float32Array(mapped);
            const floatsPerRow = bytesPerRow / 4;
            for (let y = 0; y < state.height; y++) {
              const rowStart = y * floatsPerRow;
              for (let x = 0; x < state.width; x++) {
                const start = rowStart + (x * 4);
                reshaped.push(Array.from(data.slice(start, start + 4)));
              }
            }
          } else {
            const data = new Uint8Array(mapped);
            for (let y = 0; y < state.height; y++) {
              const rowStart = y * bytesPerRow;
              for (let x = 0; x < state.width; x++) {
                const start = rowStart + (x * 4);
                reshaped.push(Array.from(data.slice(start, start + 4)).map(v => v / 255.0));
              }
            }
          }
          state.data = reshaped;
        } else {
          const data = new Float32Array(mapped);
          const layout = new ShaderLayout(this.allStructs);
          const compCount = layout.getComponentCount(state.def.dataType || 'float');
          if (compCount > 1) {
            const reshaped = [];
            for (let i = 0; i < data.length && reshaped.length < state.width; i += compCount) {
              reshaped.push(Array.from(data.slice(i, i + compCount)));
            }
            state.data = reshaped;
          } else {
            state.data = Array.from(data).slice(0, state.width);
          }
        }
      }
      staging.destroy();
    }));
  }

  /**
   * Explicitly read back a resource from GPU to CPU ResourceState.
   */
  public async readbackResource(id: string): Promise<void> {
    await this.syncResults([id]);
  }

  /**
   * Execute a "Draw" function on the GPU.
   */
  async executeDraw(targetId: string, vertexId: string, fragmentId: string, vertexCount: number, pipelineDef: RenderPipelineDef, allResources: ResourceDef[]) {
    // 1. Prepare Pipeline
    const entry = await this.prepareRenderPipeline(vertexId, fragmentId, pipelineDef, allResources, [targetId]);
    const { pipeline, metadata } = entry;

    // 2. Prepare Target Texture
    const texture = this.ensureTexture(targetId);
    if (!texture) throw new Error(`Target '${targetId}' is not a valid texture resource`);

    const view = texture.createView();

    // 3. Encoder & Pass
    const encoder = this.device.createCommandEncoder();

    this.device.pushErrorScope('validation');

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 }
      }]
    });

    const hasBindings = metadata.resourceBindings.size > 0 || (metadata.inputBinding !== undefined);
    if (hasBindings) {
      const bindGroup = await this.createUniversalBindGroup(pipeline, metadata, [targetId]);
      pass.setBindGroup(0, bindGroup);
    }

    pass.setPipeline(pipeline);
    pass.setViewport(0, 0, texture.width, texture.height, 0, 1);
    pass.setScissorRect(0, 0, texture.width, texture.height);
    pass.draw(vertexCount);
    pass.end();

    const drawError = await this.device.popErrorScope();
    if (drawError) {
      console.error(`[WebGpuExecutor] Draw Validation Error: ${drawError.message}`);
      throw new Error(`WebGPU Draw Validation Error: ${drawError.message}`);
    }

    // 4. Readback
    const bytesPerRow = Math.ceil((texture.width * 4) / 256) * 256;
    const stagingBuffer = this.device.createBuffer({
      size: bytesPerRow * texture.height,
      usage: (globalThis as any).GPUBufferUsage.COPY_DST | (globalThis as any).GPUBufferUsage.MAP_READ
    });

    encoder.copyTextureToBuffer({ texture }, { buffer: stagingBuffer, bytesPerRow }, [texture.width, texture.height, 1]);
    this.device.queue.submit([encoder.finish()]);

    await this.device.queue.onSubmittedWorkDone();
    await stagingBuffer.mapAsync((globalThis as any).GPUMapMode.READ);
    const data = new Uint8Array(stagingBuffer.getMappedRange());

    const res = this.resources.get(targetId);
    if (res) {
      const reshaped = [];
      for (let y = 0; y < texture.height; y++) {
        const rowStart = y * bytesPerRow;
        for (let x = 0; x < texture.width; x++) {
          const start = rowStart + (x * 4);
          reshaped.push(Array.from(data.slice(start, start + 4)).map(v => v / 255.0));
        }
      }
      res.data = reshaped;
    }
    stagingBuffer.unmap();
    stagingBuffer.destroy();
  }

  private async prepareRenderPipeline(vertexId: string, fragmentId: string, def: RenderPipelineDef, allResources: ResourceDef[], excludeBindings: string[] = []): Promise<{ pipeline: GPURenderPipeline, metadata: CompilationMetadata }> {
    const key = `${vertexId}|${fragmentId}|${JSON.stringify(def)}|${excludeBindings.join(',')}`;
    if (this.activeRenderPipelines.has(key)) return this.activeRenderPipelines.get(key)!;

    const generator = new WgslGenerator();
    const options: any = {
      resourceBindings: new Map<string, number>(),
      resourceDefs: new Map<string, ResourceDef>(),
      inputBinding: 1
    };

    let bindingIdx = 2;
    this.resources.forEach((state, id) => {
      if (excludeBindings.includes(id)) return;
      options.resourceBindings.set(id, bindingIdx++);
      options.resourceDefs.set(id, state.def);
    });

    const vsResult = generator.compileFunctions(this.allFunctions, vertexId, { ...options, stage: 'vertex', excludeIds: [fragmentId] }, { structs: this.allStructs });
    const fsResult = generator.compileFunctions(this.allFunctions, fragmentId, { ...options, stage: 'fragment', excludeIds: [vertexId] }, { structs: this.allStructs });

    const vsModule = await GpuCache.getShaderModule(this.device, vsResult.code);
    const fsModule = await GpuCache.getShaderModule(this.device, fsResult.code);

    const targetFormat: GPUTextureFormat = 'rgba8unorm';
    const pipeline = await this.device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: vsModule, entryPoint: 'main' },
      fragment: {
        module: fsModule,
        entryPoint: 'main',
        targets: [{
          format: targetFormat,
          blend: def.blend ? { color: def.blend.color as any, alpha: def.blend.alpha as any } : undefined
        }]
      },
      primitive: {
        topology: (def.topology || 'triangle-list') as any,
        cullMode: (def.cullMode || 'none') as any,
        frontFace: (def.frontFace || 'ccw') as any
      }
    });

    const entry = { pipeline, metadata: vsResult.metadata };
    this.activeRenderPipelines.set(key, entry);
    return entry;
  }

  private async createUniversalBindGroup(pipeline: GPURenderPipeline | GPUComputePipeline, metadata: CompilationMetadata, excludeIds: string[] = []): Promise<GPUBindGroup> {
    const entries: GPUBindGroupEntry[] = [];
    metadata.resourceBindings.forEach((binding, resId) => {
      if (excludeIds.includes(resId)) return;
      const state = this.resources.get(resId);
      if (!state) return;

      if (state.def.type === 'texture2d') {
        const tex = this.ensureTexture(resId);
        if (tex) {
          this.writeTextureData(resId);
          entries.push({ binding, resource: tex.createView() });
        }
      } else {
        if (!(state as any).gpuBuffer) {
          const layout = new ShaderLayout(this.allStructs);
          const compCount = layout.getComponentCount(state.def.dataType || 'float');
          (state as any).gpuBuffer = this.device.createBuffer({
            size: Math.max(state.width * compCount * 4, 16),
            usage: (globalThis as any).GPUBufferUsage.STORAGE | (globalThis as any).GPUBufferUsage.COPY_SRC | (globalThis as any).GPUBufferUsage.COPY_DST
          });
        }
        entries.push({ binding, resource: { buffer: (state as any).gpuBuffer } });
      }
    });

    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries
    });
  }

  private ensureTexture(id: string): GPUTexture | undefined {
    const state = this.resources.get(id);
    if (!state || state.def.type !== 'texture2d') return undefined;

    if ((state as any).gpuTexture) {
      const tex = (state as any).gpuTexture as GPUTexture;
      if (tex.width !== state.width || tex.height !== state.height) {
        tex.destroy();
        (state as any).gpuTexture = undefined;
      }
    }

    if (!(state as any).gpuTexture) {
      let format: GPUTextureFormat = 'rgba8unorm';
      const formatMap: any = { 'rgba8': 'rgba8unorm', 'rgba16f': 'rgba16float', 'rgba32f': 'rgba32float' };
      if (state.def.format) format = formatMap[state.def.format as any] || (state.def.format as any);

      const gpuTexture = this.device.createTexture({
        label: id,
        size: [state.width, state.height, 1],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
      });
      (state as any).gpuTexture = gpuTexture;
    }
    return (state as any).gpuTexture;
  }

  private writeTextureData(id: string) {
    const state = this.resources.get(id);
    if (!state || !state.data || state.def.type !== 'texture2d') return;

    const gpuTexture = (state as any).gpuTexture as GPUTexture;
    if (!gpuTexture) return;

    const irFormat = (state.def.format || 'rgba8').toString().toLowerCase();
    const isFloat = irFormat.includes('32f') || irFormat.includes('16f') || irFormat.includes('float');

    if (isFloat) {
      const flatData = new Float32Array(state.width * state.height * 4);
      for (let i = 0; i < state.data.length && i < state.width * state.height; i++) {
        const val = state.data[i] as number[];
        if (Array.isArray(val)) {
          flatData.set(val, i * 4);
        } else {
          flatData[i * 4] = val as any;
        }
      }
      this.device.queue.writeTexture(
        { texture: gpuTexture },
        flatData,
        { bytesPerRow: state.width * 16 },
        [state.width, state.height, 1]
      );
    } else {
      const flatData = new Uint8Array(state.width * state.height * 4);
      for (let i = 0; i < state.data.length && i < state.width * state.height; i++) {
        const val = state.data[i] as number[];
        if (Array.isArray(val)) {
          flatData[i * 4] = Math.max(0, Math.min(255, val[0] * 255));
          flatData[i * 4 + 1] = Math.max(0, Math.min(255, (val[1] ?? 0) * 255));
          flatData[i * 4 + 2] = Math.max(0, Math.min(255, (val[2] ?? 0) * 255));
          flatData[i * 4 + 3] = Math.max(0, Math.min(255, (val[3] ?? 1) * 255));
        } else {
          flatData[i * 4] = Math.max(0, Math.min(255, (val as any) * 255));
          flatData[i * 4 + 1] = flatData[i * 4];
          flatData[i * 4 + 2] = flatData[i * 4];
          flatData[i * 4 + 3] = 255;
        }
      }
      this.device.queue.writeTexture(
        { texture: gpuTexture },
        flatData,
        { bytesPerRow: state.width * 4 },
        [state.width, state.height, 1]
      );
    }
  }


}
