import { IRDocument } from '../ir/types';
import { CompiledJitResult } from './cpu-jit';
import { ResourceState, RuntimeValue, RenderPipelineDef } from './host-interface';
import { IGpuExecutor } from './webgpu-host';

/**
 * A mock executor that doesn't require a real GPUDevice.
 * Useful for testing RuntimeManager and ReplManager in isolation.
 */
export class MockGpuExecutor implements IGpuExecutor {
  async executeShader(funcId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue>, resources: Map<string, ResourceState>): Promise<void> {
    console.log(`[MockGpuExecutor] executeShader: ${funcId}`, { workgroups, args });
  }

  async executeDraw(targetId: string, vertexId: string, fragmentId: string, count: number, pipeline: RenderPipelineDef, resources: Map<string, ResourceState>, args?: Record<string, RuntimeValue>): Promise<void> {
    console.log(`[MockGpuExecutor] executeDraw: ${targetId}`, { vertexId, fragmentId, count });
  }

  executeSyncToCpu(resourceId: string, resources: Map<string, ResourceState>): void {
    console.log(`[MockGpuExecutor] executeSyncToCpu: ${resourceId}`);
  }

  async executeWaitCpuSync(resourceId: string, resources: Map<string, ResourceState>): Promise<void> {
    console.log(`[MockGpuExecutor] executeWaitCpuSync: ${resourceId}`);
  }

  executeCopyBuffer(srcId: string, dstId: string, srcOffset: number, dstOffset: number, count: number, resources: Map<string, ResourceState>): void {
    // CPU-only fallback for mock
    const src = resources.get(srcId);
    const dst = resources.get(dstId);
    if (!src || !dst || !src.data || !dst.data) return;
    const maxFromSrc = src.data.length - srcOffset;
    const maxToDst = dst.data.length - dstOffset;
    let actualCount = Math.min(maxFromSrc, maxToDst);
    if (count !== Infinity && count >= 0) actualCount = Math.min(actualCount, count);
    for (let i = 0; i < actualCount; i++) {
      dst.data[dstOffset + i] = src.data[srcOffset + i];
    }
  }

  executeCopyTexture(srcId: string, dstId: string, srcRect: [number, number, number, number] | null,
                     dstRect: [number, number, number, number] | null, sample: string | null,
                     alpha: number, normalized: boolean, resources: Map<string, ResourceState>): void {
    console.log(`[MockGpuExecutor] executeCopyTexture: ${srcId} -> ${dstId}`);
  }
}

/**
 * A mock version of WebGpuHost.
 */
export class MockWebGpuHost {
  readonly resources: Map<string, ResourceState>;
  readonly executor: MockGpuExecutor;

  constructor(resources: Map<string, ResourceState>) {
    this.resources = resources;
    this.executor = new MockGpuExecutor();
  }

  async dispatch(targetId: string, threadCounts: [number, number, number], args: Record<string, RuntimeValue>): Promise<void> {
    await this.executor.executeShader(targetId, threadCounts, args, this.resources);
  }

  async draw(targetId: string, vertexId: string, fragmentId: string, vertexCount: number, pipeline: RenderPipelineDef): Promise<void> {
    await this.executor.executeDraw(targetId, vertexId, fragmentId, vertexCount, pipeline, this.resources, {});
  }

  executeSyncToCpu(resId: string): void {
    this.executor.executeSyncToCpu(resId, this.resources);
  }

  async executeWaitCpuSync(resId: string): Promise<void> {
    await this.executor.executeWaitCpuSync(resId, this.resources);
  }

  resize(resId: string, size: number | number[], format?: string | number, clear?: any): void {
    console.log(`[MockWebGpuHost] resize: ${resId}`, { size, format, clear });
  }

  log(message: string, payload?: any): void {
    console.log(`[MockWebGpuHost] log: ${message}`, payload);
  }
}
