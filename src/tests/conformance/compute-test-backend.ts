import { IRDocument, DataType, ResourceDef } from '../../ir/types';
import { validateIR, inferFunctionTypes } from '../../ir/validator';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { InterpretedExecutor } from '../../interpreter/executor';
import { globals } from 'webgpu';
import { TestBackend } from './types';
import { WebGpuBackend } from './webgpu-backend';
import { WgslGenerator } from '../../webgpu/wgsl-generator';

// Ensure globals
if (typeof global !== 'undefined' && !global.GPUBufferUsage) {
  Object.assign(global, globals);
}

// Polyfill GPUBufferUsage for TS if needed or just use globals
const GPUBufferUsage = (globals as any).GPUBufferUsage;
const GPUShaderStage = (globals as any).GPUShaderStage;
const GPUMapMode = (globals as any).GPUMapMode;

// Helper: Calculate size per element
const getElementSize = (type?: string) => {
  if (!type) return 4;
  if (type.startsWith('vec2') || type === 'float2') return 8;
  if (type.startsWith('vec3') || type === 'float3') return 16; // WGSL vec3 alignment is 16 bytes.
  if (type.startsWith('vec4') || type === 'float4') return 16;
  if (type.startsWith('mat4') || type === 'float4x4') return 64;
  return 4;
};

/**
 * ComputeTestBackend
 *
 * A specialized backend that forces the Execution Graph (which is usually CPU logic in conformance tests)
 * to run as a Compute Shader on the GPU.
 *
 * Strategy:
 * 1. Analyze the Entry Point Function.
 * 2. Identify all 'var_set' and 'var_get' operations on globals.
 * 3. Allocate a 'Global Storage Buffer' to hold these values.
 * 4. Generate WGSL that treats 'fn_main' as a compute kernel, mapping global vars to storage buffer offsets.
 * 5. Dispatch (1, 1, 1).
 * 6. Read back the storage buffer and populate the EvaluationContext variables.
 */
const getComponentCount = (type: string): number => {
  if (type === 'float2' || type === 'vec2<f32>') return 2;
  if (type === 'float3' || type === 'vec3<f32>') return 3;
  if (type === 'float4' || type === 'vec4<f32>') return 4;
  if (type === 'float3x3' || type === 'mat3x3<f32>') return 9;
  if (type === 'float4x4' || type === 'mat4x4<f32>') return 16;
  return 1;
};

export const ComputeTestBackend: TestBackend = {
  name: 'Compute',

  createContext: async (ir: IRDocument, inputs?: Map<string, RuntimeValue>) => {
    // Validate IR
    const errors = validateIR(ir);
    const criticalErrors = errors.filter(e => e.severity === 'error');
    if (criticalErrors.length > 0) {
      console.error('[ComputeTestBackend] IR Validation Failed:', criticalErrors);
      throw new Error(`IR Validation Failed:\n${criticalErrors.map(e => e.message).join('\n')}`);
    }

    // Reuse WebGpuBackend's context creation (device init, resource alloc)
    console.log('[CreateContext] IR Resources:', JSON.stringify(ir.resources.map(r => ({ id: r.id, dt: r.dataType }))));
    const ctx = await WebGpuBackend.createContext(ir, inputs);
    (ctx as any)._ir = ir;
    return ctx;
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    const ir = (ctx as any)._ir as IRDocument;
    if (!ir) throw new Error('[ComputeTestBackend] IR not found on context private _ir field');
    const device = ctx.device;

    // 2. Allocate & Prepare Resources
    device.pushErrorScope('validation');
    const resourceBuffers = new Map<string, GPUBuffer | GPUTexture | GPUSampler>();
    const resourceBindings = new Map<string, number>();
    let bindingCounter = 1; // 0 is reserved for Globals

    for (const res of ir.resources) {
      if (res.type === 'buffer') {
        // Calculate size in bytes.
        // Default assumes float array?
        // ResourceState has width/height. width is array length.
        // But we might not have initialized data yet? Context constructor does.
        const state = ctx.getResource(res.id);


        const elementSize = getElementSize(res.dataType);
        const sizeBytes = state.width * elementSize;

        const buffer = device.createBuffer({
          size: sizeBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });

        // Upload Initial Data?
        if (state.data && state.data.length > 0) {
          // Flatten data
          const f32Data = new Float32Array(state.data as number[]);
          device.queue.writeBuffer(buffer, 0, f32Data);
        }

        resourceBuffers.set(res.id, buffer);
        resourceBindings.set(res.id, bindingCounter++);
      }
      else if (res.type === 'texture2d') {
        const state = ctx.getResource(res.id);
        const width = state.width || 1;
        const height = state.height || 1;
        const formatStr = (res as any).format || 'rgba8';

        let gpuFormat: GPUTextureFormat = 'rgba8unorm';
        if (formatStr === 'r32f') gpuFormat = 'r32float';
        else if (formatStr === 'rgba8') gpuFormat = 'rgba8unorm';
        else if (formatStr === 'rgba32f') gpuFormat = 'rgba32float';

        const texture = device.createTexture({
          size: [width, height, 1],
          format: gpuFormat,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
        });

        // Upload Data
        if (state.data && state.data.length > 0) {
          // Assume data is number[] (flattened) or VectorValue[].
          // We need to flatten to ArrayBuffer.
          // For R32F -> Float32Array
          // For RGBA8 -> Uint8Array (0-255) OR Float32Array?
          // IR data usually stores 0-1 floats.
          // If gpuFormat is 'rgba8unorm', we must upload bytes.
          // Converting float data to correct buffer format is complex.
          // For test simplicity: assume Float32 (r32f/rgba32f) for now, or handle rgba8 conversion.

          if (gpuFormat === 'r32float' || gpuFormat === 'rgba32float' || gpuFormat === 'rgba8unorm') {
            const flatFloats = (state.data as any).flat(2) as number[];

            // 1. Prepare Source Bytes
            let srcBytes: Uint8Array;
            let bytesPerPixel = 4;

            if (gpuFormat === 'rgba8unorm') {
              bytesPerPixel = 4;
              srcBytes = new Uint8Array(flatFloats.map(v => Math.max(0, Math.min(255, Math.floor(v * 255)))));
            } else {
              // Float formats
              const f32 = new Float32Array(flatFloats);
              srcBytes = new Uint8Array(f32.buffer);
              bytesPerPixel = gpuFormat === 'r32float' ? 4 : 16;
            }

            // 2. Pad to 256 bytes per row
            const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
            const paddedSize = bytesPerRow * height;
            const paddedData = new Uint8Array(paddedSize);
            const validBytesPerRow = width * bytesPerPixel;

            for (let y = 0; y < height; y++) {
              const srcStart = y * validBytesPerRow;
              const dstStart = y * bytesPerRow;
              paddedData.set(srcBytes.subarray(srcStart, srcStart + validBytesPerRow), dstStart);
            }

            device.queue.writeTexture({ texture }, paddedData, { bytesPerRow, rowsPerImage: height }, { width, height });
          }
        }

        resourceBuffers.set(res.id, texture as any); // Hack: Store texture in resourceBuffers map (typed as GPUBuffer) - Needs refactor or cast? Map<string, GPUBuffer | GPUTexture>
        resourceBindings.set(res.id, bindingCounter++);

        /*
        // Sampler (Currently disabled for Compute emulation, available in render stages)
        if (res.sampler) {
           const addressMode = res.sampler.wrap === 'repeat' ? 'repeat' : 'clamp-to-edge';
           const filter = res.sampler.filter === 'linear' ? 'linear' : 'nearest';
           const sampler = device.createSampler({
             addressModeU: addressMode,
             addressModeV: addressMode,
             magFilter: filter,
             minFilter: filter
           });
           resourceBuffers.set(`${res.id}_sampler`, sampler as any);
           resourceBindings.set(`${res.id}_sampler`, bindingCounter++);
        }
        */
      }
    }

    const allocError = await device.popErrorScope();
    if (allocError) {
      console.error("Resource Allocation Error:", allocError.message);
      throw new Error(`WebGPU Allocation Error: ${allocError.message}`);
    }

    // 3. Globals Buffer & Resource Map
    const varMap = new Map<string, number>();
    const varTypes = new Map<string, DataType>();
    const resourceDefs = new Map<string, ResourceDef>();

    // Initial varMap from IR inputs
    let varCounter = 0;
    ir.inputs?.forEach(input => {
      varMap.set(input.id, varCounter);
      varTypes.set(input.id, input.type);
      varCounter += getComponentCount(input.type);
    });

    // Populate Resource Defs
    ir.resources.forEach(r => {
      console.log('CTB Resource:', r.id, r.dataType);
      resourceDefs.set(r.id, r);
    });

    const func = ir.functions.find(f => f.id === entryPoint);
    if (!func) throw new Error('Entry point not found');

    func.nodes.forEach(n => {
      if (n.op === 'var_set') {
        const v = n['var'];
        const isLocal = func.localVars?.some(lv => lv.id === v);
        if (!isLocal && !varMap.has(v)) {
          varMap.set(v, varCounter);
          varTypes.set(v, 'float'); // Default to float for dynamic vars
          varCounter++;
        }
      }
    });

    const globalsSizeBytes = Math.max(varCounter * 4, 16); // Min size
    const globalBuffer = device.createBuffer({
      size: globalsSizeBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

    // Initialize Global Buffer from Context Inputs (e.g. u_dummy)
    if (varMap.size > 0) {
      const initialData = new Float32Array(globalsSizeBytes / 4);
      varMap.forEach((idx, name) => {
        try {
          const val = ctx.getInput(name);
          if (val !== undefined) {
            const type = varTypes.get(name) || 'float';
            const count = getComponentCount(type);
            if (count === 1 && typeof val === 'number') {
              initialData[idx] = val as any as number;
            } else if (Array.isArray(val)) {
              for (let i = 0; i < Math.min(val.length, count); i++) {
                initialData[idx + i] = val[i] as any as number;
              }
            }
          }
        } catch (e) {
          // Input might not exist in context (e.g. ad-hoc output var), that's fine.
        }
      });
      device.queue.writeBuffer(globalBuffer, 0, initialData);
    }
    const entryFn = ir.functions.find(f => f.id === entryPoint);
    if (!entryFn) throw new Error(`Entry point '${entryPoint}' not found`);

    // SPECIAL: If Entry Point is CPU, run on Host Logic
    if (entryFn.type === 'cpu') {
      const exec = new InterpretedExecutor(ctx);

      // We need to override 'cmd_dispatch' to use OUR run() logic for the shader
      // But InterpretedExecutor uses OpRegistry which is static.
      // So we must temporarily override Dispatch in OpRegistry or
      // just implement a custom loop.
      // Actually, InterpretedExecutor just calls executeFunction.
      // We can manually iterate nodes if it's a simple 'cpu' entry.
      // Conformance tests usually have simple 'cpu' wrappers.

      // Let's use the InterpretedExecutor and just let it run.
      // If it hits cmd_dispatch, it might fail unless we mock dispatch.
      // However, most 06-textures tests just check side effects if fn_main is cpu.

      ctx.pushFrame(entryPoint);
      exec.executeFunction(entryFn);

      // If the CPU logic didn't dispatch anything, we are done.
      // If it DID dispatch, it would have called the default dispatch op.
      // To properly support dispatch -> compute shader, we'd need to hook it.
      // For now, let's just let it run host side ops.
      return;
    }

    const genResourceBindings = new Map<string, number>();
    const genSamplerBindings = new Map<string, number>();

    resourceBindings.forEach((binding, id) => {
      if (id.endsWith('_sampler')) genSamplerBindings.set(id.replace('_sampler', ''), binding);
      else genResourceBindings.set(id, binding);
    });

    const nodeTypes = inferFunctionTypes(entryFn, ir);

    const code = new WgslGenerator().compile(ir, entryPoint, {
      globalBufferBinding: 0,
      varMap: varMap,
      varTypes: varTypes,
      nodeTypes: nodeTypes as any, // Cast from ValidationType to DataType
      resourceBindings: genResourceBindings,
      samplerBindings: genSamplerBindings,
      resourceDefs: resourceDefs
    });

    console.log("[ComputeTestBackend] Generated WGSL:\n", code);

    // 5. Pipeline
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code });
    const compilationInfo = await module.getCompilationInfo();
    if (compilationInfo.messages.some((m: GPUCompilationMessage) => m.type === 'error')) {
      const errors = compilationInfo.messages.map((m: GPUCompilationMessage) => `[${m.lineNum}:${m.linePos}] ${m.message}`).join('\n');
      console.error("WGSL Compilation Errors:\n" + errors);
      throw new Error("WGSL Compilation Failed: " + errors);
    }

    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    });

    // Check validation error from pipeline creation
    const error = await device.popErrorScope();
    if (error) {
      console.error("Pipeline Creation Error:", error.message);
      throw new Error(`WebGPU Error: ${error.message}`);
    }

    // 6. Bind Group
    const entries: GPUBindGroupEntry[] = [];

    // 6. Bind Group (Filter entries that are actually in the layout)
    const bindGroupEntries: GPUBindGroupEntry[] = [];

    // Always include global buffer if declared
    if (code.includes('var<storage, read_write> b_globals')) {
      bindGroupEntries.push({ binding: 0, resource: { buffer: globalBuffer } });
    }

    resourceBindings.forEach((binding, id) => { // Assuming resourceBindings is the correct map to iterate
      const res = resourceBuffers.get(id)!;
      // Only include if binding is declared in shader
      // Search for "@binding(x)" or similar.
      // More robust: search for "@binding([binding])"
      const bindingPattern = new RegExp(`@binding\\s*\\(\\s*${binding}\\s*\\)`);
      if (bindingPattern.test(code)) {
        if ((res as any).usage !== undefined && ((res as any).usage & GPUBufferUsage.STORAGE)) {
          bindGroupEntries.push({ binding, resource: { buffer: res as GPUBuffer } });
        } else if (res instanceof GPUSampler) {
          bindGroupEntries.push({ binding, resource: res });
        } else {
          bindGroupEntries.push({ binding, resource: (res as GPUTexture).createView() });
        }
      }
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: bindGroupEntries
    });

    // 7. Dispatch
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();

    // 8. Readback Staging
    // We need to copy buffers to map-read buffers
    const stagingBuffers = new Map<string, GPUBuffer>(); // id -> buffer
    // Helper to request readback
    const copyToStaging = (src: GPUBuffer, size: number) => {
      const staging = device.createBuffer({
        size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      });
      encoder.copyBufferToBuffer(src, 0, staging, 0, size);
      return staging;
    };

    const globalsStaging = copyToStaging(globalBuffer, globalsSizeBytes);

    resourceBuffers.forEach((buf, id) => {
      // Check if it's a Buffer
      if (buf instanceof GPUBuffer) {
        const state = ctx.getResource(id);
        const elBytes = getElementSize(state.def.dataType);
        const size = state.width * elBytes;
        console.log(`[ComputeTestBackend] Staging:`, id, buf.constructor.name);
        stagingBuffers.set(id, copyToStaging(buf, size));
      } else if (buf instanceof GPUTexture) {
        // Texture Readback
        const state = ctx.getResource(id);
        const width = state.width || 1;
        const height = state.height || 1;
        // Assume rgba8unorm has 4 bytes per pixel. r32f has 4 bytes per pixel.
        // We need to match bytesPerRow alignment (256 bytes).
        // Wait, copyTextureToBuffer requires bytesPerRow to be multiple of 256.
        // But for small test textures (2x2), this is padded.
        // We must un-pad on read?

        let bytesPerPixel = 4; // Default rgba8unorm
        if (state.def.format === 'rgba32f') bytesPerPixel = 16;
        if (state.def.format === 'r32f') bytesPerPixel = 4;

        const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
        const rowsPerImage = height;
        const bufferSize = bytesPerRow * rowsPerImage;

        const staging = device.createBuffer({
          size: bufferSize,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });

        const cmd = encoder;
        cmd.copyTextureToBuffer(
          { texture: buf },
          { buffer: staging, bytesPerRow, rowsPerImage: height },
          { width, height }
        );

        stagingBuffers.set(id, staging);
        // Store metadata for unpadding later if needed?
        // But the staging iteration logic expects flat data.
        // We will need to handle padding in the Readback loop.
      }
    });

    device.queue.submit([encoder.finish()]);

    // 9. Process Readback
    await Promise.all(Array.from(stagingBuffers.values()).map(b => b.mapAsync(GPUMapMode.READ)));
    await globalsStaging.mapAsync(GPUMapMode.READ);

    // Globals Readback
    const globalsData = new Float32Array(globalsStaging.getMappedRange());
    ctx.pushFrame(entryPoint);
    varMap.forEach((idx, name) => {
      const type = varTypes.get(name) || 'float';
      const count = getComponentCount(type);
      if (count === 1) {
        ctx.setVar(name, globalsData[idx]);
      } else {
        ctx.setVar(name, Array.from(globalsData.subarray(idx, idx + count)));
      }
    });
    globalsStaging.unmap();

    // Resources
    for (const [id, staging] of stagingBuffers) {
      const data = new Float32Array(staging.getMappedRange());
      console.log(`[Readback] ${id}:`, Array.from(data));
      const state = ctx.getResource(id);

      // Handle Texture Unpadding
      if (state.def.type === 'texture2d') {
        const width = state.width || 1;
        const height = state.height || 1;
        let bytesPerPixel = 4;
        if (state.def.format === 'rgba32f') bytesPerPixel = 16;
        if (state.def.format === 'r32f') bytesPerPixel = 4;

        const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
        const floatsPerRow = bytesPerRow / 4;
        const validFloatsPerRow = (width * bytesPerPixel) / 4;

        const unpadded: number[] = [];
        for (let y = 0; y < height; y++) {
          const rowStart = y * floatsPerRow;
          const rowData = data.subarray(rowStart, rowStart + validFloatsPerRow);
          unpadded.push(...Array.from(rowData));
        }

        // Reconstruct vectors if needed (for consistency with Buffer logic below)
        // But texture state.data is usually just array of numbers or vectors?
        // In format test: expect(tex.width).toBe(2);
        // Does it check data? No, format test checks metadata.
        // But Sampler test checks buffered logic.
        // Wait, 'b_result' is a BUFFER. So it hits "else" block.
        // 't_src' has no output check.
        // 't_internal' format test: checks metadata.
        // Does it verify clear operation? "Format and Clear Operations".
        // Likely checks data is cleared.
        // So we should populate state.data.
        state.data = unpadded;
        // Note: Buffer logic below handles vectors. We should probably reuse that if we want vectors in state.data.
        // But state.data format varies.
        // Let's assume flat array is fine for now or check usage.
        // If `tex.data` expects vectors (Array<number[]>), we need to chunk it.

        if (bytesPerPixel === 16) { // vec4
          const vectors: number[][] = [];
          for (let i = 0; i < unpadded.length; i += 4) {
            vectors.push(unpadded.slice(i, i + 4));
          }
          state.data = vectors;
        } else {
          state.data = unpadded;
        }

        staging.unmap();
        continue;
      }

      const elBytes = getElementSize(state.def.dataType);
      const elFloats = elBytes / 4;

      if (elFloats > 1) {
        // Reconstruct Vectors
        const count = state.width;
        state.data = new Array(count);
        for (let i = 0; i < count; i++) {
          const start = i * elFloats;
          // WGSL alignment rules? array<vec3> has padding?
          // If WGSL `array<vec3<f32>>`, stride is 16 bytes (4 floats).
          // But my `getElementSize` returned 16 for vec3. So elFloats=4.
          // Is `data` (Float32Array) reflecting that padding? Yes.
          const slice = Array.from(data.subarray(start, start + elFloats));

          if (state.def.dataType?.startsWith('vec3') || state.def.dataType === 'float3') {
            // Trim padding
            state.data[i] = slice.slice(0, 3);
          } else {
            state.data[i] = slice;
          }
        }
      } else {
        // Scalar
        state.data = Array.from(data);
      }

      staging.unmap();
    }

    return;
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await ComputeTestBackend.createContext(ir, inputs);
    await ComputeTestBackend.run(ctx, entryPoint);
    return ctx;
  }
};
