
import { IRDocument, ResourceDef } from '../../ir/types';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { WgslGenerator } from '../../compiler/wgsl/wgsl-generator';
import { globals } from 'webgpu';
import { TestBackend } from './test-runner';
import { WebGpuBackend } from './webgpu-backend';

// Ensure globals
if (typeof global !== 'undefined' && !global.GPUBufferUsage) {
  Object.assign(global, globals);
}

// Polyfill GPUBufferUsage for TS if needed or just use globals
const GPUBufferUsage = globals.GPUBufferUsage;
const GPUShaderStage = globals.GPUShaderStage;
const GPUMapMode = globals.GPUMapMode;

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
export const ComputeTestBackend: TestBackend = {
  name: 'Compute',

  createContext: async (ir: IRDocument, inputs?: Map<string, RuntimeValue>) => {
    // Reuse WebGpuBackend's context creation (device init, resource alloc)
    return WebGpuBackend.createContext(ir, inputs);
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    // This run method is invalid for this backend since 'execute' handles the full flow
    // including buffer readback which 'run' signature doesn't easily support without side effects.
    // However, execute calls run usually.
    // We will override execute mostly.
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    // 1. Setup Context
    const ctx = await ComputeTestBackend.createContext(ir, inputs);
    const device = ctx.device; // Assume it was added by WebGpuBackend.createContext

    // 2. Allocate & Prepare Resources
    const resourceBuffers = new Map<string, GPUBuffer>();
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
      // TODO: Textures
    }

    // 3. Globals Buffer & Resource Map
    const varMap = new Map<string, number>();
    const resourceDefs = new Map<string, ResourceDef>();

    // Populate Resource Defs
    ir.resources.forEach(r => resourceDefs.set(r.id, r));

    const func = ir.functions.find(f => f.id === entryPoint);
    if (!func) throw new Error('Entry point not found');

    let varCounter = 0;
    func?.nodes.forEach(n => {
      if (n.op === 'var_set') {
        const v = n['var'];
        const isLocal = func.localVars?.some(lv => lv.id === v);
        if (!isLocal && !varMap.has(v)) varMap.set(v, varCounter++);
      }
    });

    const globalsSizeBytes = Math.max(varCounter * 4, 16); // Min size
    const globalBuffer = device.createBuffer({
      size: globalsSizeBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    const entryFn = ir.functions.find(f => f.id === entryPoint);
    if (!entryFn) throw new Error(`Entry point '${entryPoint}' not found`);

    const code = new WgslGenerator().compile(ir, entryPoint, {
      globalBufferBinding: 0,
      varMap: varMap,
      resourceBindings: resourceBindings,
      resourceDefs: resourceDefs
    });

    console.log("[ComputeTestBackend] Generated WGSL:\n", code);

    // 5. Pipeline
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code });
    const compilationInfo = await module.getCompilationInfo();
    if (compilationInfo.messages.some(m => m.type === 'error')) {
      const errors = compilationInfo.messages.map(m => `[${m.lineNum}:${m.linePos}] ${m.message}`).join('\n');
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

    // Only bind globals if we have variables mapped or force binding if layout expects it?
    // With auto layout, unused bindings are stripped.
    // varMap tracks 'var_set'.
    // We should assume if varMap size > 0, we use it (to write).
    // If varMap is empty, but we read? 'var_get' of uninitialized var reads from globals?
    // For now, check if varMap has usage.
    if (varMap.size > 0) {
      entries.push({ binding: 0, resource: { buffer: globalBuffer } });
    }

    resourceBuffers.forEach((buf, id) => {
      const binding = resourceBindings.get(id)!;
      entries.push({ binding, resource: { buffer: buf } });
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries
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
      const state = ctx.getResource(id);
      const elBytes = getElementSize(state.def.dataType);
      const size = state.width * elBytes;
      stagingBuffers.set(id, copyToStaging(buf, size));
    });

    device.queue.submit([encoder.finish()]);

    // 9. Process Readback
    await Promise.all(Array.from(stagingBuffers.values()).map(b => b.mapAsync(GPUMapMode.READ)));
    await globalsStaging.mapAsync(GPUMapMode.READ);

    // Globals Readback
    const globalsData = new Float32Array(globalsStaging.getMappedRange());
    ctx.pushFrame(entryPoint);
    varMap.forEach((idx, name) => {
      ctx.setVar(name, globalsData[idx]);
    });
    globalsStaging.unmap();

    // Resources
    for (const [id, staging] of stagingBuffers) {
      const data = new Float32Array(staging.getMappedRange());
      const state = ctx.getResource(id);

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

    return ctx;
  }
};
