import { create, globals } from 'webgpu';

// Ensure globals for Node.js
if (typeof global !== 'undefined' && !global.GPUBufferUsage) {
  Object.assign(global, globals);
}

let device: GPUDevice | null = null;

export async function getSharedDevice(): Promise<GPUDevice> {
  if (device) return device;

  const entry = create([]);
  const adapter = await entry.requestAdapter();
  if (!adapter) throw new Error('No WebGPU Adapter found');
  device = await adapter.requestDevice();

  // Handle lost device
  device.lost.then((info) => {
    console.error(`WebGPU Device lost: ${info.message}`);
    device = null;
  });

  return device;
}
