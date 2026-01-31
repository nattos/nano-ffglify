
import { it, expect } from 'vitest';
import { create, globals } from 'webgpu';

it('should initialize WebGPU without crashing', async () => {
  Object.assign(global, globals);
  const entry = create([]);
  const adapter = await entry.requestAdapter();
  if (!adapter) throw new Error('No adapter');
  const device = await adapter.requestDevice();
  if (!device) throw new Error('No device');

  expect(device).toBeDefined();

  const buffer = device.createBuffer({
    size: 16,
    usage: (globals as any).GPUBufferUsage.STORAGE
  });
  expect(buffer).toBeDefined();

  const code = `
    @group(0) @binding(0) var<storage, read_write> b : array<f32>;
    @compute @workgroup_size(1)
    fn main() {
      b[0] = 42.0;
    }
  `;
  const module = device.createShaderModule({ code });
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main' }
  });
  expect(pipeline).toBeDefined();

  buffer.destroy();
});
