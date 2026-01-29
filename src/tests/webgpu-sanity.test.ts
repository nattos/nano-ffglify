import { describe, it, expect } from 'vitest';
import { create, globals } from 'webgpu';

// Put GPU types/constants on global scope
Object.assign(globalish(), globals);

function globalish() {
  if (typeof global !== 'undefined') return global;
  if (typeof window !== 'undefined') return window;
  if (typeof self !== 'undefined') return self;
  return {};
}

describe('WebGPU Sanity', () => {
  it('should run a minimal Compute Shader', async () => {
    // 1. Initialize
    // 'create' returns the GPU interface implementation
    const entry = create([]);
    expect(entry).toBeDefined();

    const adapter = await entry.requestAdapter();
    expect(adapter).toBeDefined();

    const device = await adapter!.requestDevice();
    expect(device).toBeDefined();

    // 2. Create Buffer (Output)
    // We want to write a single float (4 bytes)
    const bufferSize = 4;
    const bufferFunc = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const bufferRead = device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    // 3. Create Shader Module
    const shaderCode = `
      @group(0) @binding(0) var<storage, read_write> output : array<f32>;

      @compute @workgroup_size(1)
      fn main() {
        output[0] = 123.0;
      }
    `;
    const module = device.createShaderModule({
      code: shaderCode
    });

    // 4. Pipeline & BindGroup
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: bufferFunc } }]
    });

    // 5. Encode Commands
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();

    // Copy to read buffer
    encoder.copyBufferToBuffer(bufferFunc, 0, bufferRead, 0, bufferSize);

    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);

    // 6. Map and Read
    await bufferRead.mapAsync(GPUMapMode.READ);
    const arrayBuffer = bufferRead.getMappedRange();
    const result = new Float32Array(arrayBuffer);

    expect(result[0]).toBe(123.0);

    bufferRead.unmap();
  });
});
