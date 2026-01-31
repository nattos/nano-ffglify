
import { create, globals } from 'webgpu';
import { WgslGenerator } from './src/webgpu/wgsl-generator';
import { IRDocument } from './src/ir/types';

// Polyfill
Object.assign(global, globals);

async function run() {
  const entry = create([]);
  const adapter = await entry.requestAdapter();
  const device = await adapter.requestDevice()!;

  const ir: IRDocument = {
    functions: [
      {
        id: 'main',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'op_0', op: 'float2', x: 1, y: 2 },
          { id: 'comp_0_0', op: 'vec_swizzle', vec: 'op_0', channels: 'x' },
          { id: 'store_0_0', op: 'buffer_store', buffer: 'b_result', index: 0, value: 'comp_0_0' },
          { id: 'comp_0_1', op: 'vec_swizzle', vec: 'op_0', channels: 'y' },
          { id: 'store_0_1', op: 'buffer_store', buffer: 'b_result', index: 1, value: 'comp_0_1' }
        ],
        edges: [
          { from: 'op_0', portOut: 'val', to: 'comp_0_0', portIn: 'vec', type: 'data' },
          { from: 'op_0', portOut: 'val', to: 'comp_0_1', portIn: 'vec', type: 'data' },
          { from: 'comp_0_0', portOut: 'val', to: 'store_0_0', portIn: 'value', type: 'data' },
          { from: 'comp_0_1', portOut: 'val', to: 'store_0_1', portIn: 'value', type: 'data' },
          { from: 'store_0_0', portOut: 'exec_out', to: 'store_0_1', portIn: 'exec_in', type: 'execution' }
        ]
      }
    ],
    resources: [
      { id: 'b_result', type: 'buffer', dataType: 'float' }
    ],
    structs: []
  };

  const generator = new WgslGenerator();
  const code = generator.compile(ir, 'main', {
    resourceBindings: new Map([['b_result', 0]]),
    resourceDefs: new Map([['b_result', ir.resources[0]]])
  });

  console.log("WGSL Code:");
  console.log(code);

  const buffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });

  const module = device.createShaderModule({ code });
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main' }
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }]
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1, 1, 1);
  pass.end();

  const staging = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
  });
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, 256);

  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const data = new Float32Array(staging.getMappedRange());
  console.log("Result:", Array.from(data.slice(0, 2)));
  staging.unmap();

  process.exit(0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
