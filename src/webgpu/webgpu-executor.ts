import { FunctionDef, ResourceDef, StructDef, TextureFormat } from '../ir/types';
import { RuntimeValue, ResourceState } from '../ir/resource-store';
import { BuiltinOp, TextureFormatFromId, RenderPipelineDef } from '../ir/types';
import { WgslGenerator } from './wgsl-generator';
import { GpuCache } from './gpu-cache';

// Helper to polyfill if needed, similar to test
// WebGPU Globals are managed in gpu-singleton.ts

export class WebGpuExecutor {
  device: GPUDevice;
  resources: Map<string, ResourceState>;
  inputs: Map<string, RuntimeValue>;

  private activePipelines: Map<string, GPUComputePipeline> = new Map();
  private activeRenderPipelines: Map<string, GPURenderPipeline> = new Map();
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
      console.log(`[WebGpuExecutor] Scanning CPU function ${f.id} for dispatches`);
      for (const node of f.nodes) {
        if (node.op === 'cmd_dispatch' && node.func) {
          console.log(`[WebGpuExecutor] Found dispatch to ${node.func} in ${f.id}`);
          computeShaders.add(node.func);
        }
        if (node.op === 'cmd_draw') {
          if (node.vertex) renderShaders.add(node.vertex);
          if (node.fragment) renderShaders.add(node.fragment);
        }
      }
    }

    for (const func of functions) {
      if (func.type !== 'shader') {
        console.log(`[WebGpuExecutor] Skipping ${func.id} (type: ${func.type})`);
        continue;
      }

      // If it's a render shader, we don't create a compute pipeline for it
      const isCompute = computeShaders.has(func.id) || (!renderShaders.has(func.id));
      console.log(`[WebGpuExecutor] Function ${func.id}: isCompute=${isCompute}, in computeShaders=${computeShaders.has(func.id)}, in renderShaders=${renderShaders.has(func.id)}`);
      if (!isCompute) continue;

      // Options for compilation
      const options: any = {
        inputBinding: 1,
        resourceBindings: new Map<string, number>(),
        resourceDefs: new Map<string, ResourceDef>(),
        stage: 'compute'
      };

      // ... same resource loop ...
      let bindingIdx = 2;
      allResources.forEach(res => {
        options.resourceBindings!.set(res.id, bindingIdx++);
        options.resourceDefs!.set(res.id, res);
      });

      const code = generator.compileFunctions(functions, func.id, options, { structs });
      console.log(`[WebGpuExecutor] Generated WGSL for ${func.id}:\n${code}`);

      try {
        const pipeline = await GpuCache.getComputePipeline(this.device, code);
        this.activePipelines.set(func.id, pipeline);
      } catch (e: any) {
        console.warn(`[WebGpuExecutor] Failed to pre-compile compute pipeline for ${func.id}: ${e.message}`);
        // If it was supposed to be a render shader but we didn't detect it, this is silent-ish
      }
    }
  }

  /**
   * Unimplemented: Transpilation is now done in initialize.
   */
  private compileWgsl(func: FunctionDef): string {
    throw new Error('WGSL should be pre-compiled in initialize()');
  }

  /**
   * Execute a "Compute" function on the GPU.
   */
  async executeShader(func: FunctionDef, workgroups: [number, number, number], args: Record<string, RuntimeValue> = {}) {
    const funcId = func.id;

    // 1. Get Pipeline
    const pipeline = this.activePipelines.get(funcId);
    if (!pipeline) {
      throw new Error(`[WebGpuExecutor] No pre-compiled pipeline for ${funcId}`);
    }

    // 2. Prepare Inputs Buffer
    let bindGroup: GPUBindGroup | undefined;
    const nonBuiltinInputs = func.inputs.filter(i => !i.builtin);
    // WGSL rule: Runtime-sized arrays MUST be the last member of a struct.
    // We MUST use the same sorting logic as WgslGenerator.
    const sortedInputs = [...nonBuiltinInputs].sort((a, b) => {
      const aIsArr = a.type.includes('[]') || (a.type.startsWith('array<') && !a.type.includes(','));
      const bIsArr = b.type.includes('[]') || (b.type.startsWith('array<') && !b.type.includes(','));
      if (aIsArr && !bIsArr) return 1;
      if (!aIsArr && bIsArr) return -1;
      return 0;
    });

    const entries: GPUBindGroupEntry[] = [];
    const stagingBuffers: { id: string, staging: GPUBuffer, isTexture?: boolean }[] = [];
    let inputBuffer: GPUBuffer | undefined;

    if (sortedInputs.length > 0) {
      const bufferData = this.packArguments(sortedInputs, args);
      // Force STORAGE usage to match WgslGenerator's address space for Inputs struct.
      const usage = (globalThis as any).GPUBufferUsage.STORAGE;

      inputBuffer = this.device.createBuffer({
        label: `${funcId}_inputs`,
        size: bufferData.byteLength,
        usage: usage | (globalThis as any).GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(inputBuffer, 0, bufferData);

      entries.push({ binding: 1, resource: { buffer: inputBuffer } });
    }

    // 3. Create BindGroup with ONLY used resources
    const usedResources = WgslGenerator.findUsedResources(func, Array.from(this.resources.values()).map(r => r.def));

    Array.from(this.resources.values()).forEach((state, idx) => {
      const res = state.def;
      if (!usedResources.has(res.id)) return; // Skip unused resources for this shader

      const binding = 2 + idx;

      if (res.type === 'texture2d') {
        const tex = this.ensureTexture(res.id);
        if (tex) entries.push({ binding, resource: tex.createView() });
      } else {
        const compCount = this.getComponentCount(res.dataType || 'float');
        const finalSize = Math.max(state.width * compCount * 4, 16);

        // Re-allocate if size mismatch
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
        // Always sync data to GPU before dispatch if it exists in CPU memory
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
    pass.dispatchWorkgroups(...workgroups);
    pass.end();

    // 5. Read-back (Important for conformance tests)
    this.resources.forEach((state, id) => {
      const res = state.def;
      if (res.type === 'texture2d') {
        const gpuTexture = (state as any).gpuTexture as GPUTexture;
        if (gpuTexture) {
          const bytesPerRow = Math.ceil((state.width * 4) / 256) * 256;
          const staging = this.device.createBuffer({
            size: bytesPerRow * state.height,
            usage: (globalThis as any).GPUBufferUsage.MAP_READ | (globalThis as any).GPUBufferUsage.COPY_DST
          });
          encoder.copyTextureToBuffer(
            { texture: gpuTexture },
            { buffer: staging, bytesPerRow },
            [state.width, state.height, 1]
          );
          stagingBuffers.push({ id: res.id, staging, isTexture: true });
        }
      } else {
        const gpuBuffer = (state as any).gpuBuffer as GPUBuffer;
        if (gpuBuffer) {
          const staging = this.device.createBuffer({
            size: gpuBuffer.size,
            usage: (globalThis as any).GPUBufferUsage.MAP_READ | (globalThis as any).GPUBufferUsage.COPY_DST
          });
          encoder.copyBufferToBuffer(gpuBuffer, 0, staging, 0, gpuBuffer.size);
          stagingBuffers.push({ id: res.id, staging });
        }
      }
    });

    this.device.queue.submit([encoder.finish()]);

    // 6. Wait for results and sync to Context
    await Promise.all(stagingBuffers.map(async ({ id, staging, isTexture }) => {
      await staging.mapAsync((globalThis as any).GPUMapMode.READ);
      const state = this.resources.get(id);
      if (state) {
        if (isTexture) {
          const mapped = staging.getMappedRange();
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
          const mapped = staging.getMappedRange();
          const data = new Float32Array(mapped);
          const compCount = this.getComponentCount(state.def.dataType || 'float');
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
      staging.unmap();
      staging.destroy();
    }));

    if (inputBuffer) {
      inputBuffer.destroy();
    }
  }

  /**
   * Execute a "Draw" function on the GPU.
   */
  async executeDraw(
    targetId: string,
    vertexId: string,
    fragmentId: string,
    vertexCount: number,
    pipelineDef: RenderPipelineDef,
    allResources: ResourceDef[]
  ) {
    console.log(`[WebGpuExecutor] executeDraw: target=${targetId}, VS=${vertexId}, FS=${fragmentId}, count=${vertexCount}`);
    // 1. Prepare Pipeline
    const pipeline = await this.prepareRenderPipeline(vertexId, fragmentId, pipelineDef, allResources);

    // 2. Prepare Target Texture
    const texture = this.ensureTexture(targetId);
    if (!texture) throw new Error(`Target '${targetId}' is not a valid texture resource`);

    const view = texture.createView();

    // 3. Encoder & Pass
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: view,
        loadOp: 'clear', // TODO: Make configurable or respect existing clear logic
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 }
      }]
    });

    console.log(`[WebGpuExecutor] Creating universal bind group for render...`);
    const bindGroup = await this.createUniversalBindGroup(pipeline, [targetId]);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);

    // 5. Draw
    pass.draw(vertexCount);
    pass.end();

    // 6. Readback
    // Copy target texture to staging buffer to sync with context
    // Assuming target is rgba8unorm (4 bytes per pixel)
    const bytesPerRow = Math.ceil((texture.width * 4) / 256) * 256;
    const stagingBuffer = this.device.createBuffer({
      size: bytesPerRow * texture.height,
      usage: (globalThis as any).GPUBufferUsage.COPY_DST | (globalThis as any).GPUBufferUsage.MAP_READ
    });

    encoder.copyTextureToBuffer(
      { texture },
      { buffer: stagingBuffer, bytesPerRow },
      [texture.width, texture.height, 1]
    );

    this.device.queue.submit([encoder.finish()]);

    // Wait and Map
    await stagingBuffer.mapAsync((globalThis as any).GPUMapMode.READ);
    const data = new Uint8Array(stagingBuffer.getMappedRange());

    const res = this.resources.get(targetId);
    if (res) {
      const reshaped = [];
      for (let y = 0; y < texture.height; y++) {
        const rowStart = y * bytesPerRow;
        for (let x = 0; x < texture.width; x++) {
          const start = rowStart + (x * 4);
          const pixel = Array.from(data.slice(start, start + 4)).map(v => v / 255.0);
          reshaped.push(pixel);
        }
      }
      res.data = reshaped;
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();
  }

  private async prepareRenderPipeline(vertexId: string, fragmentId: string, def: RenderPipelineDef, allResources: ResourceDef[]): Promise<GPURenderPipeline> {
    const key = `${vertexId}|${fragmentId}|${JSON.stringify(def)}`;
    if (this.activeRenderPipelines.has(key)) return this.activeRenderPipelines.get(key)!;

    const generator = new WgslGenerator();

    // Options (Need to populate resources for bindings)
    const options = {
      resourceBindings: new Map<string, number>(),
      resourceDefs: new Map<string, ResourceDef>(),
      globalBufferBinding: 0, // Using Buffer 0 for globals? No, use bindings from 2.
      // Wait, ComputeExecutor uses:
      // inputBinding: 1
      // resources: 2+
    };

    // We need to define bindings consistent with 'createUniversalBindGroup'.
    // Let's assume:
    // Binding 0: Globals (if needed? we removed it in ComputeExecutor?)
    // Binding 1: Inputs/Uniforms
    // Binding 2+: Resources
    // ComputeExecutor.initialize actually used: inputBinding=1.
    // And resources starting at 2.

    let bindingIdx = 2;
    allResources.forEach(res => {
      options.resourceBindings!.set(res.id, bindingIdx++);
      options.resourceDefs!.set(res.id, res);
    });

    const vsOptions = { ...options, stage: 'vertex' as const, inputBinding: 1, excludeIds: [fragmentId] };
    const fsOptions = { ...options, stage: 'fragment' as const, inputBinding: 1, excludeIds: [vertexId] };

    // Note: compileFunctions should be used here too if dependencies are needed
    const vsCode = generator.compileFunctions(this.allFunctions, vertexId, vsOptions, { structs: this.allStructs });
    const fsCode = generator.compileFunctions(this.allFunctions, fragmentId, fsOptions, { structs: this.allStructs });

    console.log(`[WebGpuExecutor] VS Code for ${vertexId}:\n${vsCode}`);
    console.log(`[WebGpuExecutor] FS Code for ${fragmentId}:\n${fsCode}`);

    const vsModule = this.device.createShaderModule({ code: vsCode, label: vertexId });
    const fsModule = this.device.createShaderModule({ code: fsCode, label: fragmentId });

    // Target Format
    // We assume target is rgba8unorm unless specified.
    // We should look up the target ID to get format?
    // But pipeline is cached by DEF. Def doesn't verify target format compatibility.
    // WebGPU requires pipeline to match target format.
    // So 'def' usually implies a target format or we assume a default.
    // For now, hardcode 'rgba8unorm' or make it part of cache key?
    // Ideally, pass format in 'def' or look up target?
    // Let's assume 'rgba8unorm' for sanity tests.
    const targetFormat: GPUTextureFormat = 'rgba8unorm';

    // Auto-assign locations for VS outputs / FS inputs if missing
    // Actually WgslGenerator should handle this.
    // Let's ensure WgslGenerator is robust.

    const pipeline = await this.device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: vsModule, entryPoint: 'main' },
      fragment: {
        module: fsModule,
        entryPoint: 'main',
        targets: [{
          format: targetFormat,
          blend: def.blend ? {
            color: def.blend.color as GPUBlendComponent,
            alpha: def.blend.alpha as GPUBlendComponent
          } : undefined
        }]
      },
      primitive: {
        topology: (def.topology || 'triangle-list') as GPUPrimitiveTopology,
        cullMode: def.cullMode as GPUCullMode,
        frontFace: def.frontFace as GPUFrontFace
      }
    });

    this.activeRenderPipelines.set(key, pipeline);
    return pipeline;
  }

  private ensureTexture(id: string): GPUTexture | undefined {
    const state = this.resources.get(id);
    if (!state) return undefined;
    if (state.def.type !== 'texture2d') return undefined; // Only textures

    if ((state as any).gpuTexture) {
      const tex = (state as any).gpuTexture as GPUTexture;
      if (tex.width !== state.width || tex.height !== state.height) {
        tex.destroy();
        (state as any).gpuTexture = undefined;
      }
    }

    if (!(state as any).gpuTexture) {
      let format: string = 'rgba8unorm';
      const irFormat = state.def.format;
      if (typeof irFormat === 'number') {
        format = (TextureFormatFromId as any)[irFormat] || 'rgba8unorm';
      } else if (typeof irFormat === 'string') {
        format = irFormat;
      }

      // Normalize IR format strings to WebGPU standards
      const formatMap: Record<string, GPUTextureFormat> = {
        'rgba8': 'rgba8unorm',
        'rgba16f': 'rgba16float',
        'rgba32f': 'rgba32float',
        'r8': 'r8unorm',
        'r16f': 'r16float',
        'r32f': 'r32float',
      };
      const finalFormat = formatMap[format] || format as GPUTextureFormat;

      const gpuTexture = this.device.createTexture({
        label: id,
        size: [state.width, state.height, 1],
        format: finalFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
      });
      (state as any).gpuTexture = gpuTexture;

      // Sync initial data if any
      if (state.data && state.data.length > 0) {
        const flat = (state.data as any).flat(2) as number[];
        const expectedBytes = state.width * state.height * (finalFormat.startsWith('r32') || finalFormat.startsWith('r8') ? 1 : 4) * (finalFormat.includes('float') || finalFormat.includes('32f') ? 4 : 1);

        // If length doesn't match (e.g. only 1 channel provided for RGBA), we might need to be careful.
        // For now, let's only sync if length is at least enough to cover the texture.
        const currentBytes = flat.length * (finalFormat.includes('float') || finalFormat.includes('32f') ? 4 : 1);

        if (currentBytes === expectedBytes) {
          if (finalFormat.includes('8unorm')) {
            const u8 = new Uint8Array(flat.map(v => Math.floor(v * 255)));
            this.device.queue.writeTexture(
              { texture: gpuTexture },
              u8,
              { bytesPerRow: state.width * 4 },
              [state.width, state.height, 1]
            );
          } else if (finalFormat.includes('float') || finalFormat.includes('32f')) {
            const f32 = new Float32Array(flat);
            const bytesPerPixel = finalFormat.startsWith('r32') ? 4 : 16;
            this.device.queue.writeTexture(
              { texture: gpuTexture },
              f32,
              { bytesPerRow: state.width * bytesPerPixel },
              [state.width, state.height, 1]
            );
          }
        }
      }
    }
    return (state as any).gpuTexture;
  }

  private async createUniversalBindGroup(pipeline: GPURenderPipeline | GPUComputePipeline, excludeIds: string[] = []): Promise<GPUBindGroup> {
    // Helper to match bindings used in generation
    // Copied/Refactored from executeShader logic
    // Binding 1: Inputs
    // Binding 2+: Resources
    // TODO: Factor out common binding logic.
    // For now, implementing minimal inputs buffer logic.
    const entries: GPUBindGroupEntry[] = [];
    // Inputs binding (1)
    // ... logic implies we need 'func' to pack arguments.
    // But 'utils' might not have current function inputs?
    // 'executeDraw' doesn't pass inputs yet.
    // Let's assume no inputs for now or fix later.
    // Just bind resources.
    Array.from(this.resources.values()).forEach((state, idx) => {
      const res = state.def;
      if (excludeIds.includes(res.id)) return;
      const binding = 2 + idx;
      // If buffer, bind buffer. If texture, bind texture view?
      // Generator assumes 'texture_2d<f32>' for texture resources?
      // If so, `resource: view`.
      if (res.type === 'texture2d') {
        const tex = this.ensureTexture(res.id);
        if (tex) entries.push({ binding, resource: tex.createView() });
      } else {
        // Buffer
        // Ensure buffer
        if (!(state as any).gpuBuffer) {
          const compCount = this.getComponentCount(res.dataType || 'float');
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

  private getComponentCount(type: string): number {
    if (type === 'float' || type === 'int' || type === 'bool' || type === 'f32' || type === 'i32') return 1;
    if (type === 'float2' || type === 'vec2<f32>') return 2;
    if (type === 'float3' || type === 'vec3<f32>') return 3;
    if (type === 'float4' || type === 'vec4<f32>' || type === 'quat') return 4;
    if (type === 'float3x3' || type === 'mat3x3<f32>') return 9;
    if (type === 'float4x4' || type === 'mat4x4<f32>') return 16;
    return 1;
  }

  private packArguments(inputs: { id: string, type: string, builtin?: string }[], args: Record<string, RuntimeValue>): ArrayBuffer {
    let offset = 0;
    const packedData: { offset: number, value: RuntimeValue, type: string }[] = [];

    for (const input of inputs) {
      if (input.builtin) continue;
      const align = this.getAlignment(input.type);
      offset = Math.ceil(offset / align) * align;
      const val = args[input.id];
      packedData.push({ offset, value: val, type: input.type });

      const size = this.getPackedSize(input.type, val);
      offset += size;
    }

    // Storage buffer alignment for total size (usually 16)
    const buffer = new ArrayBuffer(Math.max(16, Math.ceil(offset / 16) * 16));
    const view = new DataView(buffer);
    for (const item of packedData) {
      console.log(`[WebGpuExecutor] Packing ${item.type} at offset ${item.offset}. Value:`, item.value);
      this.writeToBuffer(view, item.offset, item.value, item.type);
    }
    console.log(`[WebGpuExecutor] Final buffer data:`, new Float32Array(buffer));
    return buffer;
  }

  private getAlignment(type: string): number {
    const t = type.toLowerCase();
    if (t === 'float' || t === 'int' || t === 'bool' || t === 'f32' || t === 'i32' || t === 'u32') return 4;
    if (t === 'float2' || t === 'vec2<f32>') return 8;
    if (t === 'float3' || t === 'vec3<f32>' || t === 'float4' || t === 'vec4<f32>' || t === 'quat') return 16;
    if (t === 'float3x3' || t === 'mat3x3<f32>' || t === 'float4x4' || t === 'mat4x4<f32>') return 16;

    if (t.includes('[') || t.startsWith('array<')) {
      const inner = t.replace('[]', '').replace('array<', '').split(',')[0].replace('>', '').trim();
      return this.getAlignment(inner);
    }

    const struct = this.allStructs.find(s => s.id.toLowerCase() === type.toLowerCase());
    if (struct) {
      let maxAlign = 4;
      for (const m of struct.members) maxAlign = Math.max(maxAlign, this.getAlignment(m.type));
      return maxAlign;
    }
    return 16;
  }

  private getPackedSize(type: string, val?: RuntimeValue): number {
    const t = type.toLowerCase();
    if (t === 'float' || t === 'int' || t === 'bool' || t === 'f32' || t === 'i32' || t === 'u32') return 4;
    if (t === 'float2' || t === 'vec2<f32>') return 8;
    if (t === 'float3' || t === 'vec3<f32>') return 12;
    if (t === 'float4' || t === 'vec4<f32>' || t === 'quat') return 16;
    if (t === 'float3x3' || t === 'mat3x3<f32>') return 48; // 3 x 16-stride columns
    if (t === 'float4x4' || t === 'mat4x4<f32>') return 64; // 4 x 16-stride columns

    if (t.includes('[') || t.startsWith('array<')) {
      if (Array.isArray(val)) {
        const inner = t.replace('[]', '').replace('array<', '').split(',')[0].replace('>', '').trim();
        const elemSize = this.getPackedSize(inner);
        const elemAlign = this.getAlignment(inner);
        const stride = Math.ceil(elemSize / elemAlign) * elemAlign;
        return val.length * stride;
      }
      return 0;
    }

    const struct = this.allStructs.find(s => s.id.toLowerCase() === t);
    if (struct) {
      let structOffset = 0;
      let maxAlign = 4;
      for (const m of struct.members) {
        const mAlign = this.getAlignment(m.type);
        maxAlign = Math.max(maxAlign, mAlign);
        structOffset = Math.ceil(structOffset / mAlign) * mAlign;
        structOffset += this.getPackedSize(m.type);
      }
      return Math.ceil(structOffset / maxAlign) * maxAlign;
    }
    return 16;
  }

  private writeToBuffer(view: DataView, offset: number, val: RuntimeValue, type: string) {
    const t = type.toLowerCase();
    if (typeof val === 'number') {
      if (t === 'int' || t === 'i32') view.setInt32(offset, val, true);
      else if (t === 'u32' || t === 'uint') view.setUint32(offset, val, true);
      else view.setFloat32(offset, val, true);
    } else if (typeof val === 'boolean') {
      view.setUint32(offset, val ? 1 : 0, true);
    } else if (Array.isArray(val)) {
      if (t.startsWith('mat') || (t.startsWith('float') && t.includes('x'))) {
        const dim = (t.includes('3x3') || t.includes('3')) ? 3 : 4;
        for (let c = 0; c < dim; c++) {
          for (let r = 0; r < dim; r++) {
            view.setFloat32(offset + (c * 16) + (r * 4), val[c * dim + r] as number, true);
          }
        }
      } else if (t.includes('[') || t.startsWith('array<')) {
        const inner = type.replace('[]', '').replace('array<', '').split(',')[0].replace('>', '').trim();
        const elemSize = this.getPackedSize(inner);
        const elemAlign = this.getAlignment(inner);
        const stride = Math.ceil(elemSize / elemAlign) * elemAlign;
        for (let i = 0; i < val.length; i++) {
          this.writeToBuffer(view, offset + (i * stride), val[i] as RuntimeValue, inner);
        }
      } else {
        // float2/3/4
        for (let i = 0; i < val.length; i++) {
          view.setFloat32(offset + (i * 4), val[i] as number, true);
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      const struct = this.allStructs.find(s => s.id.toLowerCase() === t);
      if (struct) {
        let memberOffset = 0;
        for (const m of struct.members) {
          const mAlign = this.getAlignment(m.type);
          memberOffset = Math.ceil(memberOffset / mAlign) * mAlign;
          this.writeToBuffer(view, offset + memberOffset, (val as any)[m.name], m.type);
          memberOffset += this.getPackedSize(m.type);
        }
      }
    }
  }
}
