import { FunctionDef, ResourceDef } from '../ir/types';
import { EvaluationContext, RuntimeValue } from '../interpreter/context';
import { globals } from 'webgpu';
import { CpuJitCompiler } from './cpu-jit';
import { OpRegistry } from '../interpreter/ops';
import { BuiltinOp, TextureFormatFromId, RenderPipelineDef } from '../ir/types';
import { WgslGenerator } from './wgsl-generator';
import { GpuCache } from './gpu-cache';

// Helper to polyfill if needed, similar to test
// WebGPU Globals are managed in gpu-singleton.ts

export class WebGpuExecutor {
  device: GPUDevice;
  context: EvaluationContext;

  private activePipelines: Map<string, GPUComputePipeline> = new Map();
  private activeRenderPipelines: Map<string, GPURenderPipeline> = new Map();

  constructor(device: GPUDevice, context: EvaluationContext) {
    this.device = device;
    this.context = context;
    // ensureGpuGlobals() is now handled by the backends or singleton
  }

  destroy() {
    this.activePipelines.clear();
    this.activeRenderPipelines.clear();
  }

  /**
   * Pre-compile all shaders in the IR document.
   */
  async initialize() {
    const ir = this.context.ir;
    const generator = new WgslGenerator();

    for (const func of ir.functions) {
      if (func.type !== 'shader') continue;

      try {
        // Options for compilation
        // We use binding 0 for globals (if needed) and binding 1 for inputs
        const options = {
          inputBinding: 1,
          resourceBindings: new Map<string, number>(),
          resourceDefs: new Map<string, ResourceDef>(),
        };

        // Map resources used in this function to bindings starting from index 2
        let bindingIdx = 2;
        ir.resources.forEach(res => {
          options.resourceBindings!.set(res.id, bindingIdx++);
          options.resourceDefs!.set(res.id, res);
        });

        const code = generator.compile(ir, func.id, options);
        // Use Global Cache
        const pipeline = await GpuCache.getComputePipeline(this.device, code);
        this.activePipelines.set(func.id, pipeline);
      } catch (e: any) {
        console.error(`Failed to compile shader ${func.id}:`);
        console.error(e.message);
        // If it was a compilation info error, we already printed it? No, creating module doesn't throw usually.
        // Pipeline creation might.
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
  async executeShader(funcId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue> = {}) {
    const func = this.context.ir.functions.find(f => f.id === funcId);
    if (!func) throw new Error(`Function '${funcId}' not found`);
    if (func.type !== 'shader') throw new Error(`Function '${funcId}' is not a shader`);

    // 1. Get Pipeline
    const pipeline = this.activePipelines.get(funcId);
    if (!pipeline) {
      console.warn(`[WebGpuExecutor] No pre-compiled pipeline for ${funcId}, falling back to CPU JIT`);
      return this.executeShaderCpu(funcId, workgroups, args);
    }

    // 2. Prepare Inputs Buffer
    let bindGroup: GPUBindGroup | undefined;
    const nonBuiltinInputs = func.inputs.filter(i => !i.builtin);

    const entries: GPUBindGroupEntry[] = [];
    const stagingBuffers: { id: string, staging: GPUBuffer, isTexture?: boolean }[] = [];
    let inputBuffer: GPUBuffer | undefined;

    if (nonBuiltinInputs.length > 0) {
      const bufferData = this.packArguments(nonBuiltinInputs, args);
      inputBuffer = this.device.createBuffer({
        label: `${funcId}_inputs`,
        size: bufferData.byteLength,
        usage: (globalThis as any).GPUBufferUsage.UNIFORM | (globalThis as any).GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(inputBuffer, 0, bufferData);

      entries.push({ binding: 1, resource: { buffer: inputBuffer } });
    }

    // 3. Create BindGroup with ONLY used resources
    const usedResources = WgslGenerator.findUsedResources(func, this.context.ir);

    this.context.ir.resources.forEach((res, idx) => {
      if (!usedResources.has(res.id)) return; // Skip unused resources for this shader

      const binding = 2 + idx;
      const state = this.context.getResource(res.id);

      if (res.type === 'texture2d') {
        const tex = this.ensureTexture(res.id);
        if (tex) entries.push({ binding, resource: tex.createView() });
      } else {
        // Ensure GPU buffer exists
        if (!(state as any).gpuBuffer) {
          (state as any).gpuBuffer = this.device.createBuffer({
            label: res.id,
            size: Math.max(state.width * 4, 16),
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
    this.context.ir.resources.forEach(res => {
      const state = this.context.getResource(res.id);
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
      const state = this.context.getResource(id);
      if (state) {
        if (isTexture) {
          const data = new Uint8Array(staging.getMappedRange());
          const bytesPerRow = Math.ceil((state.width * 4) / 256) * 256;
          const reshaped = [];
          for (let y = 0; y < state.height; y++) {
            const rowStart = y * bytesPerRow;
            for (let x = 0; x < state.width; x++) {
              const start = rowStart + (x * 4);
              const pixel = Array.from(data.slice(start, start + 4)).map(v => v / 255.0);
              reshaped.push(pixel);
            }
          }
          state.data = reshaped;
        } else {
          const data = new Float32Array(staging.getMappedRange());
          const compCount = this.getComponentCount(state.def.dataType || 'float');
          if (compCount > 1) {
            const reshaped = [];
            for (let i = 0; i < data.length; i += compCount) reshaped.push(Array.from(data.slice(i, i + compCount)));
            state.data = reshaped;
          } else {
            state.data = Array.from(data);
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
    pipelineDef: RenderPipelineDef
  ) {
    // 1. Prepare Pipeline
    const pipeline = await this.prepareRenderPipeline(vertexId, fragmentId, pipelineDef);

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
        clearValue: { r: 0, g: 0, b: 0, a: 1 }
      }]
    });

    // 4. Bind Resources (Group 0)
    // We reuse the same logic as Compute? We need a bindgroup covering needed resources.
    // For now, let's look for a single bind group that covers relevant buffers?
    // Or just create a new one for this pass?
    // Simplified: Create a bindgroup with ALL resources (Compute style) for now.
    // This assumes specific layout compatibility.
    // We must exclude the render target (output) from bindings if not used as input.
    // TODO: Improve bind group management.
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

    const res = this.context.getResource(targetId);
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

  private async prepareRenderPipeline(vertexId: string, fragmentId: string, def: RenderPipelineDef): Promise<GPURenderPipeline> {
    const key = `${vertexId}|${fragmentId}|${JSON.stringify(def)}`;
    if (this.activeRenderPipelines.has(key)) return this.activeRenderPipelines.get(key)!;

    const generator = new WgslGenerator();
    const ir = this.context.ir;

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
    ir.resources.forEach(res => {
      options.resourceBindings!.set(res.id, bindingIdx++);
      options.resourceDefs!.set(res.id, res);
    });

    const vsOptions = { ...options, stage: 'vertex' as const, inputBinding: 1, excludeIds: [fragmentId] };
    const fsOptions = { ...options, stage: 'fragment' as const, inputBinding: 1, excludeIds: [vertexId] };

    const vsCode = generator.compile(ir, vertexId, vsOptions);
    const fsCode = generator.compile(ir, fragmentId, fsOptions);

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
    const state = this.context.getResource(id);
    if (!state) return undefined;
    if (state.def.type !== 'texture2d') return undefined; // Only textures

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
    this.context.ir.resources.forEach((res, idx) => {
      if (excludeIds.includes(res.id)) return;
      const binding = 2 + idx;
      const state = this.context.getResource(res.id);
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
          (state as any).gpuBuffer = this.device.createBuffer({
            size: Math.max(state.width * 4, 16),
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
      const size = this.getSize(input.type);
      offset = Math.ceil(offset / align) * align;
      packedData.push({ offset, value: args[input.id], type: input.type });
      offset += size;
    }

    const buffer = new ArrayBuffer(Math.ceil(offset / 16) * 16);
    const view = new DataView(buffer);
    for (const item of packedData) {
      this.writeToBuffer(view, item.offset, item.value, item.type);
    }
    return buffer;
  }

  private getAlignment(type: string): number {
    if (type === 'float' || type === 'int' || type === 'bool' || type === 'f32' || type === 'i32') return 4;
    if (type === 'float2' || type === 'vec2<f32>') return 8;
    return 16; // vec3, vec4, mat, etc.
  }

  private getSize(type: string): number {
    if (type === 'float' || type === 'int' || type === 'bool' || type === 'f32' || type === 'i32') return 4;
    if (type === 'float2' || type === 'vec2<f32>') return 8;
    if (type === 'float3' || type === 'vec3<f32>' || type === 'float4' || type === 'vec4<f32>') return 16;
    if (type === 'float3x3' || type === 'mat3x3<f32>') return 48;
    if (type === 'float4x4' || type === 'mat4x4<f32>') return 64;
    return 4;
  }

  private writeToBuffer(view: DataView, offset: number, val: RuntimeValue, type: string) {
    if (typeof val === 'number') {
      if (type === 'int' || type === 'i32') view.setInt32(offset, val, true);
      else view.setFloat32(offset, val, true);
    } else if (typeof val === 'boolean') {
      view.setInt32(offset, val ? 1 : 0, true);
    } else if (Array.isArray(val)) {
      if (type.startsWith('mat')) {
        const dim = type.includes('3x3') ? 3 : 4;
        for (let c = 0; c < dim; c++) {
          for (let r = 0; r < dim; r++) {
            view.setFloat32(offset + (c * 16) + (r * 4), val[c * dim + r] as number, true);
          }
        }
      } else {
        for (let i = 0; i < val.length; i++) {
          view.setFloat32(offset + (i * 4), val[i] as number, true);
        }
      }
    }
  }

  private executeShaderCpu(funcId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue> = {}) {
    const func = this.context.ir.functions.find(f => f.id === funcId);
    if (!func) throw new Error(`Function '${funcId}' not found`);

    const jit = new CpuJitCompiler();
    const compiled = jit.compile(func);
    let globalId = [0, 0, 0];

    // Set variables in context for function arguments
    this.context.pushFrame(funcId);
    for (const [key, val] of Object.entries(args)) {
      if (key !== 'func' && key !== 'dispatch' && key !== 'comment' && typeof val === 'string') {
        throw new Error(`Runtime Error: String marshalling to shader not supported (arg: ${key})`);
      }
      this.context.setVar(key, val);
    }

    const shaderGlobals = {
      callOp: (op: string, args: any) => {
        const handler = OpRegistry[op as BuiltinOp];
        if (!handler) throw new Error(`Op not found: ${op}`);
        return handler(this.context, args);
      },
      resolveString: (val: string) => {
        const v = this.context.getVar(val);
        if (v !== undefined) return v;
        try {
          return this.context.getInput(val);
        } catch {
          return val;
        }
      },
      resolveVar: (val: string) => {
        // Builtins
        if (val === 'GlobalInvocationID') return [...globalId];

        const v = this.context.getVar(val);
        if (v !== undefined) return v;
        try {
          return this.context.getInput(val);
        } catch {
          throw new Error(`Runtime Error: Variable '${val}' is not defined`);
        }
      },
      resize: (resId: string, size: number | number[], format?: string | number, clear?: number | number[]) => {
        // Same logic as HostExecutor
        const res = this.context.getResource(resId);
        if (res.def.type === 'buffer') {
          const newSize = typeof size === 'number' ? size : size[0];
          if (res.data && res.data.length === newSize) return;
          res.width = newSize;
          res.data = new Array(newSize).fill(0);
          if (this.context.logAction) {
            this.context.logAction('resize', resId, { size: newSize, format: 'buffer' });
          }
        } else if (res.def.type === 'texture2d') {
          const width = Array.isArray(size) ? size[0] : size as number;
          const height = Array.isArray(size) ? size[1] : 1;
          if (res.width !== width || res.height !== height) {
            res.width = width;
            res.height = height;
            if (res.def.persistence.clearOnResize) {
              const v = res.def.persistence.clearValue ?? [0, 0, 0, 0];
              res.data = new Array(width * height).fill(v);
            }
            if (this.context.logAction) {
              this.context.logAction('resize', resId, { size: [width, height], format: res.def.format });
            }
          }

          if (format !== undefined) {
            if (typeof format === 'number') {
              const strFmt = TextureFormatFromId[format];
              if (strFmt) res.def.format = strFmt;
            } else {
              res.def.format = format as any;
            }
          }

          if (clear !== undefined) {
            const v = clear;
            res.data = new Array(width * height).fill(v);
          }
        }
      },
      bufferLoad: (bufId: string, idx: number) => {
        const res = this.context.getResource(bufId);
        if (!res.data) return 0;
        if (idx < 0 || idx >= res.width) throw new Error('Runtime Error: buffer_load OOB');
        return res.data[idx] ?? 0;
      },
      callFunc: (targetId: string, args: any) => {
        throw new Error('Recursion in shader emulation not fully implemented');
      },
      dispatch: (targetId: string, wg: any) => {
        return this.executeShader(targetId, wg);
      }
    };

    const [gx, gy, gz] = workgroups;
    // Emulate Dispatch Loop
    for (let z = 0; z < gz; z++) {
      for (let y = 0; y < gy; y++) {
        for (let x = 0; x < gx; x++) {
          globalId = [x, y, z];
          compiled(this.context, this.context.resources, shaderGlobals);
        }
      }
    }

    this.context.popFrame();
  }
}
