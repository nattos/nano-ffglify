/// <reference types="@webgpu/types" />
import { IRDocument, DataType, ResourceDef } from '../../ir/types';
import { validateIR, inferFunctionTypes } from '../../ir/validator';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { gpuSemaphore } from './gpu-singleton';
import { TestBackend } from './types';
import { WebGpuBackend } from './webgpu-backend';
import { WgslGenerator } from '../../webgpu/wgsl-generator';
import { GpuCache } from '../../webgpu/gpu-cache';
import { ShaderLayout, packBuffer } from '../../webgpu/shader-layout';

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
 * ForceOntoGPUTestBackend
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
  if (type.startsWith('array<')) {
    const match = type.match(/,\s*(\d+)>/);
    if (match) return parseInt(match[1]);
  }
  return 1;
};

export const ForceOntoGPUTestBackend: TestBackend = {
  name: 'ForceOntoGPU',

  createContext: async (ir: IRDocument, inputs?: Map<string, RuntimeValue>) => {
    // Validate IR
    const errors = validateIR(ir);
    const criticalErrors = errors.filter(e => e.severity === 'error');
    if (criticalErrors.length > 0) {
      console.error('[ForceOntoGPUTestBackend] IR Validation Failed:', criticalErrors);
      throw new Error(`IR Validation Failed:\n${criticalErrors.map(e => e.message).join('\n')}`);
    }


    // Reuse WebGpuBackend's context creation (device init, resource alloc)
    const ctx = await WebGpuBackend.createContext(ir, inputs);
    (ctx as any)._ir = ir;
    return ctx;
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    const ir = (ctx as any)._ir as IRDocument;
    if (!ir) throw new Error('[ForceOntoGPUTestBackend] IR not found on context private _ir field');

    const func = ir.functions.find(f => f.id === entryPoint);
    if (!func) throw new Error('Entry point not found');

    // await gpuSemaphore.acquire();

    await gpuSemaphore.acquire();
    try {
      const device = ctx.device;

      const resourceBuffers = new Map<string, GPUBuffer | GPUTexture | GPUSampler>();
      const stagingBuffers: GPUBuffer[] = [];
      let globalBuffer: GPUBuffer | undefined;

      try {
        // 2. Allocate & Prepare Resources
        device.pushErrorScope('validation');
        const resourceBindings = new Map<string, number>();
        let bindingCounter = 2; // 0 is Globals, 1 is Inputs

        for (const res of ir.resources) {
          if (res.type === 'buffer') {
            const state = ctx.getResource(res.id);
            const elementSize = getElementSize(res.dataType);
            const sizeBytes = state.width * elementSize;

            const buffer = device.createBuffer({
              size: sizeBytes,
              usage: (globalThis as any).GPUBufferUsage.STORAGE | (globalThis as any).GPUBufferUsage.COPY_SRC | (globalThis as any).GPUBufferUsage.COPY_DST
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
              usage: (globalThis as any).GPUTextureUsage.TEXTURE_BINDING | (globalThis as any).GPUTextureUsage.STORAGE_BINDING | (globalThis as any).GPUTextureUsage.COPY_DST | (globalThis as any).GPUTextureUsage.COPY_SRC
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

        const nodeTypes = inferFunctionTypes(func, ir);

        func.nodes.forEach(n => {
          if (n.op === 'var_set') {
            const v = n['var'];
            // For conformance tests, we want to be able to read back even local variables
            // that are results of operations.
            if (!varMap.has(v)) {
              varMap.set(v, varCounter);
              const valType = nodeTypes.get(n.id) || nodeTypes.get(n['val']) || 'float';
              varTypes.set(v, valType);
              varCounter += getComponentCount(valType);
            }
          }
        });

        const globalsSizeBytes = Math.max(varCounter * 4, 16);
        globalBuffer = device.createBuffer({
          size: globalsSizeBytes,
          usage: (globalThis as any).GPUBufferUsage.STORAGE | (globalThis as any).GPUBufferUsage.COPY_SRC | (globalThis as any).GPUBufferUsage.COPY_DST
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

        const genResourceBindings = new Map<string, number>();
        const genSamplerBindings = new Map<string, number>();
        resourceBindings.forEach((binding, id) => {
          if (id.endsWith('_sampler')) genSamplerBindings.set(id.replace('_sampler', ''), binding);
          else genResourceBindings.set(id, binding);
        });

        // Handle cmd_dispatch redirection:
        // If the entry function contains a 'cmd_dispatch', we should compile the dispatched function instead.
        // This simulates a host dispatching a kernel.
        let targetEntryPoint = entryPoint;
        let dispatchSize = [1, 1, 1];

        const dispNode = func.nodes.find(n => n.op === 'cmd_dispatch');
        if (dispNode) {
          if (typeof dispNode['func'] === 'string') {
            targetEntryPoint = dispNode['func'];
            const targetFunc = ir.functions.find(f => f.id === targetEntryPoint);
            if (!targetFunc) throw new Error(`Dispatched function '${targetEntryPoint}' not found`);
          }
          let dims = dispNode['dispatch'];

          // Resolve string reference (e.g. 'tex_size' from resource_get_size)
          if (typeof dims === 'string') {
            const refNode = func.nodes.find(n => n.id === dims);
            if (refNode && refNode.op === 'resource_get_size') {
              const resId = refNode['resource'] as string;
              const res = ir.resources.find(r => r.id === resId);
              if (res && res.size?.mode === 'fixed') {
                const val = res.size.value;
                if (Array.isArray(val)) {
                  dims = [val[0], val[1], 1];
                } else {
                  dims = [val, 1, 1];
                }
              }
            } else {
              // Try to get from inputs
              const inputVal = ctx.getVar(dims);
              if (Array.isArray(inputVal)) dims = inputVal;
            }
          }

          if (Array.isArray(dims)) {
            dispatchSize = [
              (dims[0] as number) || 1,
              (dims[1] as number) || 1,
              (dims[2] as number) || 1
            ];
          }
        }


        const compilation = new WgslGenerator().compile(ir, targetEntryPoint, {
          stage: 'compute',
          globalBufferBinding: 0,
          inputBinding: 1,
          varMap: varMap,
          varTypes: varTypes,
          nodeTypes: nodeTypes as any,
          resourceBindings: genResourceBindings,
          samplerBindings: genSamplerBindings,
          resourceDefs: resourceDefs
        });

        const code = WgslGenerator.resolveImports(compilation);
        console.log("--- GENERATED WGSL ---\n", code, "\n---------------------");

        device.pushErrorScope('validation');
        const pipeline = await GpuCache.getComputePipeline(device, code);

        const error = await device.popErrorScope();
        if (error) {
          console.log("!!! WEBGPU ERROR !!!", error.message);
          throw new Error(`WebGPU Error: ${error.message}`);
        }


        const bindGroupEntries: GPUBindGroupEntry[] = [];
        if (code.includes('var<storage, read_write> b_globals') && globalBuffer) {
          bindGroupEntries.push({ binding: 0, resource: { buffer: globalBuffer } });
        }
        const layout = compilation.metadata.inputLayout;
        if (layout) {
          const wgSize = compilation.metadata.workgroupSize || [16, 16, 1];
          const totalThreads = [
            dispatchSize[0],
            dispatchSize[1],
            dispatchSize[2]
          ];
          // Determine workgroups needed to cover totalThreads
          const workgroups = [
            Math.ceil(totalThreads[0] / wgSize[0]),
            Math.ceil(totalThreads[1] / wgSize[1]),
            Math.ceil(totalThreads[2] / wgSize[2])
          ];


          const inputValues: Record<string, RuntimeValue> = {
            u_dispatch_size: totalThreads
          };
          ctx.inputs.forEach((v, k) => {
            inputValues[k] = v;
          });


          const packed = packBuffer(layout, inputValues, new ShaderLayout(ir.structs || []), 'std430');


          const buffer = device.createBuffer({
            size: packed.byteLength,
            usage: (globalThis as any).GPUBufferUsage.STORAGE | (globalThis as any).GPUBufferUsage.COPY_DST
          });
          device.queue.writeBuffer(buffer, 0, packed);
          bindGroupEntries.push({ binding: 1, resource: { buffer } });
          stagingBuffers.push(buffer); // Clean up later

          // Use these for final dispatch
          dispatchSize = workgroups;
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

        let dx = dispatchSize[0], dy = dispatchSize[1], dz = dispatchSize[2];
        // If we didn't redirect (no cmd_dispatch), check if the function itself has dispatch metadata (unlikely for strict compute backend acting as host)
        // But if we are running a pure compute shader entry point directly, we default to 1,1,1 unless specific metadata exists.

        pass.dispatchWorkgroups(dx, dy, dz);
        pass.end();

        const copyToStaging = (src: GPUBuffer, size: number) => {
          const staging = device.createBuffer({
            size,
            usage: (globalThis as any).GPUBufferUsage.MAP_READ | (globalThis as any).GPUBufferUsage.COPY_DST
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
              usage: (globalThis as any).GPUBufferUsage.MAP_READ | (globalThis as any).GPUBufferUsage.COPY_DST
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
          await globalsStaging.mapAsync((globalThis as any).GPUMapMode.READ);
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
          await staging.mapAsync((globalThis as any).GPUMapMode.READ);
          const state = ctx.getResource(id);

          if (state.def.type === 'texture2d') {
            const bytesPerPixel = 4; // Assuming RGBA8
            const bytesPerRow = Math.ceil((state.width * bytesPerPixel) / 256) * 256;
            const unpadded: any[] = [];
            for (let y = 0; y < state.height; y++) {
              const rowBytes = new Uint8Array(staging.getMappedRange(y * bytesPerRow, bytesPerRow));
              for (let x = 0; x < state.width; x++) {
                const r = rowBytes[x * 4] / 255.0;
                const g = rowBytes[x * 4 + 1] / 255.0;
                const b = rowBytes[x * 4 + 2] / 255.0;
                const a = rowBytes[x * 4 + 3] / 255.0;
                unpadded.push([r, g, b, a]);
              }
            }
            state.data = unpadded;
          } else { // Buffer resource
            const data = new Float32Array(staging.getMappedRange());
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
          staging.unmap();
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
    } finally {
      gpuSemaphore.release();
    }
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await ForceOntoGPUTestBackend.createContext(ir, inputs);
    await ForceOntoGPUTestBackend.run(ctx, entryPoint);
    return ctx;
  }
};
