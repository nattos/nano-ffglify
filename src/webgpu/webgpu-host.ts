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
    const src = this.resources.get(srcId);
    const dst = this.resources.get(dstId);
    if (!src || !dst || !src.data || !dst.data) return;

    const srcLen = src.data.length;
    const dstLen = dst.data.length;
    const maxFromSrc = srcLen - srcOffset;
    const maxToDst = dstLen - dstOffset;
    const actualCount = Math.min(count, maxFromSrc, maxToDst);

    for (let i = 0; i < actualCount; i++) {
      dst.data[dstOffset + i] = src.data[srcOffset + i];
    }
  }

  copyTexture(srcId: string, dstId: string, srcRect: [number, number, number, number] | null,
              dstRect: [number, number, number, number] | null, sample: string | null,
              alpha: number, normalized: boolean): void {
    const src = this.resources.get(srcId);
    const dst = this.resources.get(dstId);
    if (!src || !dst || !src.data || !dst.data) return;

    // Resolve rects
    let sx = 0, sy = 0, sw = src.width, sh = src.height;
    let dx = 0, dy = 0, dw = dst.width, dh = dst.height;

    if (srcRect) {
      if (normalized) {
        sx = Math.floor(srcRect[0] * src.width);
        sy = Math.floor(srcRect[1] * src.height);
        sw = Math.floor(srcRect[2] * src.width);
        sh = Math.floor(srcRect[3] * src.height);
      } else {
        sx = Math.floor(srcRect[0]); sy = Math.floor(srcRect[1]);
        sw = Math.floor(srcRect[2]); sh = Math.floor(srcRect[3]);
      }
    }
    if (dstRect) {
      if (normalized) {
        dx = Math.floor(dstRect[0] * dst.width);
        dy = Math.floor(dstRect[1] * dst.height);
        dw = Math.floor(dstRect[2] * dst.width);
        dh = Math.floor(dstRect[3] * dst.height);
      } else {
        dx = Math.floor(dstRect[0]); dy = Math.floor(dstRect[1]);
        dw = Math.floor(dstRect[2]); dh = Math.floor(dstRect[3]);
      }
    }

    if (alpha <= 0) return;

    const getSrcPixel = (px: number, py: number): number[] => {
      const cx = Math.max(0, Math.min(src.width - 1, px));
      const cy = Math.max(0, Math.min(src.height - 1, py));
      const p = src.data[cy * src.width + cx];
      return Array.isArray(p) ? p : [p, 0, 0, 1];
    };

    const sampleBilinear = (u: number, v: number): number[] => {
      const tx = u - 0.5, ty = v - 0.5;
      const x0 = Math.floor(tx), y0 = Math.floor(ty);
      const fx = tx - x0, fy = ty - y0;
      const s00 = getSrcPixel(x0, y0);
      const s10 = getSrcPixel(x0 + 1, y0);
      const s01 = getSrcPixel(x0, y0 + 1);
      const s11 = getSrcPixel(x0 + 1, y0 + 1);
      const r: number[] = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) {
        const top = s00[c] * (1 - fx) + s10[c] * fx;
        const bot = s01[c] * (1 - fx) + s11[c] * fx;
        r[c] = top * (1 - fy) + bot * fy;
      }
      return r;
    };

    const needsSampling = sample !== null && (sw !== dw || sh !== dh);

    for (let py = 0; py < dh; py++) {
      for (let px = 0; px < dw; px++) {
        const dstX = dx + px;
        const dstY = dy + py;
        if (dstX < 0 || dstX >= dst.width || dstY < 0 || dstY >= dst.height) continue;

        let pixel: number[];
        if (needsSampling) {
          const srcU = sx + (px + 0.5) * sw / dw;
          const srcV = sy + (py + 0.5) * sh / dh;
          if (sample === 'bilinear') {
            pixel = sampleBilinear(srcU, srcV);
          } else {
            // nearest
            pixel = getSrcPixel(Math.floor(srcU), Math.floor(srcV));
          }
        } else {
          // Direct copy (clamp to available)
          const srcX = sx + Math.min(px, sw - 1);
          const srcY = sy + Math.min(py, sh - 1);
          pixel = getSrcPixel(srcX, srcY);
        }

        const dstIdx = dstY * dst.width + dstX;
        if (alpha >= 1.0) {
          dst.data[dstIdx] = [...pixel];
        } else {
          // Porter-Duff source-over compositing with non-premultiplied alpha
          const existing = dst.data[dstIdx];
          const dstPixel = Array.isArray(existing) ? existing : [existing, 0, 0, 1];
          const srcA = pixel[3] * alpha;
          const dstA = dstPixel[3];
          const outA = srcA + dstA * (1 - srcA);
          const out = [0, 0, 0, outA];
          if (outA < 1e-5) {
            out[0] = out[1] = out[2] = 0;
          } else {
            for (let c = 0; c < 3; c++) {
              out[c] = (pixel[c] * srcA + dstPixel[c] * dstA * (1 - srcA)) / outA;
            }
          }
          dst.data[dstIdx] = out;
        }
      }
    }
  }

  log(message: string, payload?: any): void {
    if (this.logHandler) {
      this.logHandler(message, payload);
    }
  }
}
