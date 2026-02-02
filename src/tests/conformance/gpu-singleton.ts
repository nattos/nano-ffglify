export { getSharedDevice, Semaphore, gpuSemaphore } from '../../webgpu/gpu-device';

/**
 * @deprecated Use getSharedDevice instead. This is for backward compatibility in tests.
 */
export async function ensureGpuGlobals() {
  await import('../../webgpu/gpu-device').then(m => m.getSharedDevice());
}
