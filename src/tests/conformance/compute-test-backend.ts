
import { IRDocument } from '../../ir/types';
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
        const sizeBytes = state.width * 4; // Assume f32

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

    // 3. Globals Buffer & Map
    const varMap = new Map<string, number>();
    const func = ir.functions.find(f => f.id === entryPoint);
    if (!func) throw new Error('Entry point not found');

    let varCounter = 0;
    func?.nodes.forEach(n => {
      if (n.op === 'var_set') {
        const v = n['var'];
        if (!varMap.has(v)) varMap.set(v, varCounter++);
      }
      // 'var_get' might just read it, but if it wasn't set locally, it's an Input.
      // If it's an Input, we should pre-populate Globals Buffer!
      // TODO: Handle Inputs.
    });

    const globalsSizeBytes = Math.max(varCounter * 4, 16); // Min size
    const globalBuffer = device.createBuffer({
      size: globalsSizeBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

    // 4. Generate WGSL
    const generator = new WgslGenerator();
    const code = generator.compile(func, {
      globalBufferBinding: 0,
      varMap,
      resourceBindings
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
      const size = state.width * 4;
      stagingBuffers.set(id, copyToStaging(buf, size));
    });

    device.queue.submit([encoder.finish()]);

    // 9. Process Readback
    await Promise.all(Array.from(stagingBuffers.values()).map(b => b.mapAsync(GPUMapMode.READ)));
    await globalsStaging.mapAsync(GPUMapMode.READ);

    // Globals
    const globalsData = new Float32Array(globalsStaging.getMappedRange());

    // Update Context Frame
    ctx.pushFrame(entryPoint);
    varMap.forEach((idx, name) => {
      ctx.setVar(name, globalsData[idx]);
    });
    globalsStaging.unmap();

    // Resources
    for (const [id, staging] of stagingBuffers) {
      const data = new Float32Array(staging.getMappedRange());
      // Copy back to Context
      const state = ctx.getResource(id);
      state.data = Array.from(data);
      staging.unmap();
    }

    return ctx;
  }
};
