import { RuntimeGlobals, RuntimeValue, RenderPipelineDef, ResourceState } from './host-interface';

/**
 * Interface for the underlying GPU executor.
 * This allows the host to be decoupled from any specific executor implementation.
 */
export interface IGpuExecutor {
  executeShader(funcId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue>): Promise<void>;
  executeDraw(targetId: string, vertexId: string, fragmentId: string, count: number, pipeline: RenderPipelineDef): Promise<void>;
}

/**
 * Standalone implementation of RuntimeGlobals.
 * Bridges the JIT-compiled CPU code with the GPU executor and resource state.
 */
export class WebGpuHost implements RuntimeGlobals {
  constructor(
    // TODO: Remove all deps of the emitted code on our host's objects.
    private executor: IGpuExecutor,
    private resources: Map<string, ResourceState>,
    private onResizeCallback?: (resId: string, size: number | number[], format?: string | number) => void,
    private logHandler?: (message: string, payload?: any) => void
  ) { }

  async dispatch(targetId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue>): Promise<void> {
    await this.executor.executeShader(targetId, workgroups, args);
  }

  async draw(targetId: string, vertexId: string, fragmentId: string, vertexCount: number, pipeline: RenderPipelineDef): Promise<void> {
    await this.executor.executeDraw(targetId, vertexId, fragmentId, vertexCount, pipeline);
  }

  resize(resId: string, size: number | number[], format?: string | number, clear?: any): void {
    const res = this.resources.get(resId);
    if (!res) return;

    if (res.def.type === 'buffer') {
      const newSize = typeof size === 'number' ? size : size[0];
      // Basic CPU-side resize/reinit for the host
      if (res.data && res.data.length === newSize && clear === undefined) return;
      res.width = newSize;
      res.data = new Array(newSize).fill(clear ?? 0);
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

  log(message: string, payload?: any): void {
    if (this.logHandler) {
      this.logHandler(message, payload);
    }
  }
}
