import { create, globals } from 'webgpu';

let globalsEnsured = false;
export function ensureGpuGlobals() {
  if (globalsEnsured) return;
  if (typeof global !== 'undefined' && !global.GPUBufferUsage) {
    Object.assign(global, globals);
  }
  globalsEnsured = true;
}

let device: GPUDevice | null = null;

export async function getSharedDevice(): Promise<GPUDevice> {
  ensureGpuGlobals();
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

export class Semaphore {
  private count = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) { }

  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.count--;
    const next = this.queue.shift();
    if (next) {
      this.count++;
      next();
    }
  }
}

export const gpuSemaphore = new Semaphore(32);
