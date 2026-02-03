/// <reference types="@webgpu/types" />
/**
 * @file gpu-device.ts
 * @description Shared utility for getting the GPUDevice, supporting both browser and Node.js.
 */

let device: GPUDevice | null = null;

/**
 * Gets a shared GPUDevice.
 * In the browser, uses navigator.gpu.
 * In Node.js, dynamically imports the 'webgpu' package.
 */
export async function getSharedDevice(): Promise<GPUDevice> {
  if (device) return device;

  let gpu: GPU;

  if (typeof navigator !== 'undefined' && navigator.gpu) {
    gpu = navigator.gpu;
  } else {
    // // Node.js / Environment without native WebGPU (e.g. testing)
    // try {
    //   // Use dynamic import with a template literal to further hide it from some bundlers
    //   const packageName = 'webgpu';
    //   const { create, globals } = await import(packageName);

    //   if (typeof global !== 'undefined' && !(global as any).GPUBufferUsage) {
    //     Object.assign(global, globals);
    //   }
    //   gpu = create([]);
    // } catch (e) {
    throw new Error('WebGPU is not supported in this environment (no navigator.gpu or webgpu package)');
    // }
  }

  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU Adapter found');
  device = await adapter.requestDevice();

  // Handle lost device
  device.lost.then((info) => {
    console.error(`WebGPU Device lost: ${info.message}`);
    device = null;
  });

  return device;
}

/**
 * Semaphore for limiting concurrent GPU operations.
 */
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
