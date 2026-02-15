import { RuntimeGlobals, RuntimeValue, RenderPipelineDef, ResourceState } from './host-interface';

/**
 * Interface for the underlying GPU executor.
 * This allows the host to be decoupled from any specific executor implementation.
 */
export interface IGpuExecutor {
  executeShader(funcId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue>, resources: Map<string, ResourceState>): Promise<void>;
  executeDraw(targetId: string, vertexId: string, fragmentId: string, count: number, pipeline: RenderPipelineDef, resources: Map<string, ResourceState>, args?: Record<string, RuntimeValue>): Promise<void>;
  executeSyncToCpu(resourceId: string, resources: Map<string, ResourceState>): void;
  executeWaitCpuSync(resourceId: string, resources: Map<string, ResourceState>): Promise<void>;
  executeCopyBuffer(srcId: string, dstId: string, srcOffset: number, dstOffset: number, count: number, resources: Map<string, ResourceState>): void;
  executeCopyTexture(srcId: string, dstId: string, srcRect: [number, number, number, number] | null,
                     dstRect: [number, number, number, number] | null, sample: string | null,
                     alpha: number, normalized: boolean, resources: Map<string, ResourceState>): void;
}

/**
 * Standalone implementation of RuntimeGlobals.
 * Bridges the JIT-compiled CPU code with the GPU executor and resource state.
 */
export class WebGpuHost implements RuntimeGlobals {
  readonly inputs: Map<string, RuntimeValue>;
  readonly device;
  readonly executor;
  readonly resources;
  private onResizeCallback;
  private logHandler;

  constructor(
    init: {
      device: GPUDevice,
      executor: IGpuExecutor,
      resources: Map<string, ResourceState>,
      inputs?: Map<string, RuntimeValue>,
      onResizeCallback?: (resId: string, size: number | number[], format?: string | number) => void,
      logHandler?: (message: string, payload?: any) => void
    }
  ) {
    this.device = init.device;
    this.executor = init.executor;
    this.resources = init.resources;
    this.inputs = init.inputs || new Map();
    this.onResizeCallback = init.onResizeCallback;
    this.logHandler = init.logHandler;
  }

  async dispatch(targetId: string, threadCounts: [number, number, number], args: Record<string, RuntimeValue>): Promise<void> {
    // Merge global inputs with explicitly provided args.
    // Explicit args override global inputs of the same name.
    const mergedArgs = { ...Object.fromEntries(this.inputs.entries()), ...args };
    await this.executor.executeShader(targetId, threadCounts, mergedArgs, this.resources);
  }

  async draw(targetId: string, vertexId: string, fragmentId: string, vertexCount: number, pipeline: RenderPipelineDef): Promise<void> {
    const mergedArgs = { ...Object.fromEntries(this.inputs.entries()) };
    await this.executor.executeDraw(targetId, vertexId, fragmentId, vertexCount, pipeline, this.resources, mergedArgs);
  }

  executeSyncToCpu(resId: string): void {
    this.executor.executeSyncToCpu(resId, this.resources);
  }

  async executeWaitCpuSync(resId: string): Promise<void> {
    await this.executor.executeWaitCpuSync(resId, this.resources);
  }

  resize(resId: string, size: number | number[], format?: string | number, clear?: any): void {
    const res = this.resources.get(resId);
    if (!res) return;

    if (res.def.type === 'buffer') {
      const newSize = typeof size === 'number' ? size : size[0];
      // Basic CPU-side resize/reinit for the host
      if (res.data && res.data.length === newSize && clear === undefined) return;

      const shouldClear = clear !== undefined || (res.def.persistence?.clearOnResize !== false);

      res.width = newSize;
      if (shouldClear) {
        res.data = new Array(newSize).fill(clear ?? 0);
        // Mark CPU data as dirty so cleared data gets uploaded to GPU
        if ((res as any).flags) {
          (res as any).flags.cpuDirty = true;
        }
      } else {
        // Preserve existing data, extend with zeros for new elements
        const oldData = res.data || [];
        if (newSize <= oldData.length) {
          res.data = oldData.slice(0, newSize);
        } else {
          res.data = [...oldData, ...new Array(newSize - oldData.length).fill(0)];
        }
        // Signal _ensureGpuResource to do GPU-to-GPU copy if a GPU buffer exists
        if (res.gpuBuffer) {
          (res as any)._preserveGpuOnResize = true;
        }
      }
    } else if (res.def.type === 'texture2d') {
      const width = Array.isArray(size) ? size[0] : size;
      const height = Array.isArray(size) ? size[1] : 1;
      res.width = width;
      res.height = height;
      if (format !== undefined) {
        (res.def as any).format = format;
      }
      if (clear !== undefined) {
        res.data = new Array(width * height).fill(clear);
      }
    }

    if (this.onResizeCallback) {
      this.onResizeCallback(resId, size, format);
    }
  }

  copyBuffer(srcId: string, dstId: string, srcOffset: number, dstOffset: number, count: number): void {
    this.executor.executeCopyBuffer(srcId, dstId, srcOffset, dstOffset, count, this.resources);
  }

  copyTexture(srcId: string, dstId: string, srcRect: [number, number, number, number] | null,
              dstRect: [number, number, number, number] | null, sample: string | null,
              alpha: number, normalized: boolean): void {
    this.executor.executeCopyTexture(srcId, dstId, srcRect, dstRect, sample, alpha, normalized, this.resources);
  }

  log(message: string, payload?: any): void {
    if (this.logHandler) {
      this.logHandler(message, payload);
    }
  }
}
