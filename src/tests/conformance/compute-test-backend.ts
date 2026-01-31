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
    const ctx = await WebGpuBackend.createContext(ir, inputs);
    (ctx as any)._ir = ir;
    return ctx;
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    const ir = (ctx as any)._ir as IRDocument;
    if (!ir) throw new Error('[ComputeTestBackend] IR not found on context private _ir field');
    const device = ctx.device;

    const resourceBuffers = new Map<string, GPUBuffer | GPUTexture | GPUSampler>();
    const stagingBuffers: GPUBuffer[] = [];
    let globalBuffer: GPUBuffer | undefined;

    try {
      // 2. Allocate & Prepare Resources
      device.pushErrorScope('validation');
      const resourceBindings = new Map<string, number>();
      let bindingCounter = 1; // 0 is reserved for Globals

      for (const res of ir.resources) {
        if (res.type === 'buffer') {
          const state = ctx.getResource(res.id);
          const elementSize = getElementSize(res.dataType);
          const sizeBytes = state.width * elementSize;

          const buffer = device.createBuffer({
            size: sizeBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
          });

          if (state.data && state.data.length > 0) {
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

          if (state.data && state.data.length > 0) {
            if (gpuFormat === 'r32float' || gpuFormat === 'rgba32float' || gpuFormat === 'rgba8unorm') {
              const flatFloats = (state.data as any).flat(2) as number[];
              let srcBytes: Uint8Array;
              let bytesPerPixel = 4;

              if (gpuFormat === 'rgba8unorm') {
                bytesPerPixel = 4;
                srcBytes = new Uint8Array(flatFloats.map(v => Math.max(0, Math.min(255, Math.floor(v * 255)))));
              } else {
                const f32 = new Float32Array(flatFloats);
                srcBytes = new Uint8Array(f32.buffer);
                bytesPerPixel = gpuFormat === 'r32float' ? 4 : 16;
              }

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

          resourceBuffers.set(res.id, texture);
          resourceBindings.set(res.id, bindingCounter++);
        }
      }

      const allocError = await device.popErrorScope();
      if (allocError) {
        console.error("Resource Allocation Error:", allocError.message);
        throw new Error(`WebGPU Allocation Error: ${allocError.message}`);
      }

      const varMap = new Map<string, number>();
      const varTypes = new Map<string, DataType>();
      const resourceDefs = new Map<string, ResourceDef>();

      let varCounter = 0;
      ir.inputs?.forEach(input => {
        varMap.set(input.id, varCounter);
        varTypes.set(input.id, input.type);
        varCounter += getComponentCount(input.type);
      });

      ir.resources.forEach(r => {
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
            varTypes.set(v, 'float');
            varCounter++;
          }
        }
      });

      const globalsSizeBytes = Math.max(varCounter * 4, 16);
      globalBuffer = device.createBuffer({
        size: globalsSizeBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      });

      if (varMap.size > 0) {
        const initialData = new Float32Array(globalsSizeBytes / 4);
        varMap.forEach((idx, name) => {
          try {
            const val = ctx.getInput(name);
            if (val !== undefined) {
              const type = varTypes.get(name) || 'float';
              const count = getComponentCount(type);
              if (count === 1 && typeof val === 'number') {
                initialData[idx] = val;
              } else if (Array.isArray(val)) {
                for (let i = 0; i < Math.min(val.length, count); i++) {
                  initialData[idx + i] = val[i] as number;
                }
              }
            }
          } catch (e) { }
        });
        device.queue.writeBuffer(globalBuffer, 0, initialData);
      }

      if (func.type === 'cpu') {
        const exec = new InterpretedExecutor(ctx);
        ctx.pushFrame(entryPoint);
        exec.executeFunction(func);
        return;
      }

      const genResourceBindings = new Map<string, number>();
      const genSamplerBindings = new Map<string, number>();
      resourceBindings.forEach((binding, id) => {
        if (id.endsWith('_sampler')) genSamplerBindings.set(id.replace('_sampler', ''), binding);
        else genResourceBindings.set(id, binding);
      });

      const nodeTypes = inferFunctionTypes(func, ir);
      const code = new WgslGenerator().compile(ir, entryPoint, {
        globalBufferBinding: 0,
        varMap: varMap,
        varTypes: varTypes,
        nodeTypes: nodeTypes as any,
        resourceBindings: genResourceBindings,
        samplerBindings: genSamplerBindings,
        resourceDefs: resourceDefs
      });

      device.pushErrorScope('validation');
      const module = device.createShaderModule({ code });
      const compilationInfo = await module.getCompilationInfo();
      if (compilationInfo.messages.some((m: any) => m.type === 'error')) {
        const errors = compilationInfo.messages.map((m: any) => `[${m.lineNum}:${m.linePos}] ${m.message}`).join('\n');
        throw new Error("WGSL Compilation Failed: " + errors);
      }

      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' }
      });

      const error = await device.popErrorScope();
      if (error) throw new Error(`WebGPU Error: ${error.message}`);

      const bindGroupEntries: GPUBindGroupEntry[] = [];
      if (code.includes('var<storage, read_write> b_globals') && globalBuffer) {
        bindGroupEntries.push({ binding: 0, resource: { buffer: globalBuffer } });
      }

      resourceBindings.forEach((binding, id) => {
        const res = resourceBuffers.get(id)!;
        const bindingPattern = new RegExp(`@binding\\s*\\(\\s*${binding}\\s*\\)`);
        if (bindingPattern.test(code)) {
          if (res instanceof GPUBuffer) {
            bindGroupEntries.push({ binding, resource: { buffer: res } });
          } else if (res instanceof GPUTexture) {
            bindGroupEntries.push({ binding, resource: res.createView() });
          } else if (res instanceof GPUSampler) {
            bindGroupEntries.push({ binding, resource: res });
          }
        }
      });

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: bindGroupEntries
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);

      let dx = 1, dy = 1, dz = 1;
      const dispNode = func.nodes.find(n => n.op === 'cmd_dispatch');
      if (dispNode) {
        const dims = dispNode['dispatch'];
        if (Array.isArray(dims)) {
          dx = (dims[0] as number) || 1;
          dy = (dims[1] as number) || 1;
          dz = (dims[2] as number) || 1;
        }
      }

      pass.dispatchWorkgroups(dx, dy, dz);
      pass.end();

      const copyToStaging = (src: GPUBuffer, size: number) => {
        const staging = device.createBuffer({
          size,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        stagingBuffers.push(staging);
        encoder.copyBufferToBuffer(src, 0, staging, 0, size);
        return staging;
      };

      const globalsStaging = globalBuffer ? copyToStaging(globalBuffer, globalsSizeBytes) : null;
      const resStaging = new Map<string, GPUBuffer>();

      resourceBuffers.forEach((buf, id) => {
        if (buf instanceof GPUBuffer) {
          const state = ctx.getResource(id);
          const size = state.width * getElementSize(state.def.dataType);
          resStaging.set(id, copyToStaging(buf, size));
        } else if (buf instanceof GPUTexture) {
          const state = ctx.getResource(id);
          const width = state.width || 1;
          const height = state.height || 1;
          let bytesPerPixel = 4;
          if (state.def.format === 'rgba32f') bytesPerPixel = 16;
          if (state.def.format === 'r32f') bytesPerPixel = 4;

          const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
          const bufferSize = bytesPerRow * height;
          const staging = device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
          });
          stagingBuffers.push(staging);
          encoder.copyTextureToBuffer(
            { texture: buf },
            { buffer: staging, bytesPerRow, rowsPerImage: height },
            { width, height }
          );
          resStaging.set(id, staging);
        }
      });

      device.queue.submit([encoder.finish()]);

      await device.queue.onSubmittedWorkDone();
      if (globalsStaging) {
        await globalsStaging.mapAsync(GPUMapMode.READ);
        const globalsData = new Float32Array(globalsStaging.getMappedRange());
        ctx.pushFrame(entryPoint);
        varMap.forEach((idx, name) => {
          const type = varTypes.get(name) || 'float';
          const count = getComponentCount(type);
          if (count === 1) ctx.setVar(name, globalsData[idx]);
          else ctx.setVar(name, Array.from(globalsData.subarray(idx, idx + count)));
        });
        globalsStaging.unmap();
      }

      for (const [id, staging] of resStaging) {
        await staging.mapAsync(GPUMapMode.READ);
        const data = new Float32Array(staging.getMappedRange());
        const state = ctx.getResource(id);

        if (state.def.type === 'texture2d') {
          const width = state.width || 1;
          const height = state.height || 1;
          let bpp = 4;
          if (state.def.format === 'rgba32f') bpp = 16;
          if (state.def.format === 'r32f') bpp = 4;

          const floatsPerRow = (Math.ceil((width * bpp) / 256) * 256) / 4;
          const validFloatsPerRow = (width * bpp) / 4;
          const unpadded: number[] = [];
          for (let y = 0; y < height; y++) {
            unpadded.push(...Array.from(data.subarray(y * floatsPerRow, y * floatsPerRow + validFloatsPerRow)));
          }

          if (bpp === 16) {
            const vectors: number[][] = [];
            for (let i = 0; i < unpadded.length; i += 4) vectors.push(unpadded.slice(i, i + 4));
            state.data = vectors;
          } else {
            state.data = unpadded;
          }
        } else {
          const elFloats = getElementSize(state.def.dataType) / 4;
          if (elFloats > 1) {
            state.data = new Array(state.width);
            for (let i = 0; i < state.width; i++) {
              const slice = Array.from(data.subarray(i * elFloats, i * elFloats + elFloats));
              state.data[i] = (state.def.dataType?.startsWith('vec3') || state.def.dataType === 'float3') ? slice.slice(0, 3) : slice;
            }
          } else {
            state.data = Array.from(data);
          }
        }
      }
    } finally {
      globalBuffer?.destroy();
      for (const b of stagingBuffers) b.destroy();
      for (const res of resourceBuffers.values()) {
        if (res instanceof GPUBuffer || res instanceof GPUTexture) res.destroy();
      }
      // Note: we don't pop error scope here as it was already popped for specific operations
      // But we should ensure popErrorScope matches pushErrorScope.
      // I added push/pop around allocation and pipeline.
    }
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await ComputeTestBackend.createContext(ir, inputs);
    await ComputeTestBackend.run(ctx, entryPoint);
    return ctx;
  }
};
