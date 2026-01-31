import { globals } from 'webgpu';
import { getSharedDevice, gpuSemaphore } from './gpu-singleton';

// Ensure globals
// WebGPU Globals are managed in gpu-singleton.ts

import type { TestBackend } from './types';
import { EvaluationContext } from '../../interpreter/context';
import { WebGpuExecutor } from '../../webgpu/webgpu-executor';
import { IRDocument, FunctionDef, TextureFormatFromId, RenderPipelineDef } from '../../ir/types';
import { CpuJitCompiler } from '../../webgpu/cpu-jit';
import { HostOps } from '../../webgpu/host-ops';
import { RuntimeGlobals } from '../../webgpu/host-interface';
import { RuntimeValue, ResourceState } from '../../ir/resource-store';

class WebGpuHostExecutor {
  webGpuExec: WebGpuExecutor;
  ctx: EvaluationContext;
  jit: CpuJitCompiler;
  compiledCache: Map<string, Function> = new Map();

  constructor(ctx: EvaluationContext, webGpuExec: WebGpuExecutor) {
    this.ctx = ctx;
    this.webGpuExec = webGpuExec;
    this.jit = new CpuJitCompiler();
  }

  async executeFunction(func: FunctionDef, functions: FunctionDef[]): Promise<RuntimeValue> {
    let compiled = this.compiledCache.get(func.id);
    if (!compiled) {
      compiled = this.jit.compile(func, functions);
      this.compiledCache.set(func.id, compiled);
    }

    const globals: RuntimeGlobals = {
      dispatch: async (targetId, dim, args) => {
        const targetFunc = functions.find(f => f.id === targetId);
        if (!targetFunc) throw new Error(`Shader '${targetId}' not found`);
        await this.webGpuExec.executeShader(targetFunc, dim, args);
      },
      draw: async (targetId, vertexId, fragmentId, count, pipeline) => {
        const resources = Array.from(this.ctx.resources.values()).map(r => r.def);
        await this.webGpuExec.executeDraw(targetId, vertexId, fragmentId, count, pipeline, resources);
      },
      resize: (resId, size, format, clear) => {
        const res = this.ctx.resources.get(resId);
        if (!res) throw new Error(`Resource '${resId}' not found`);

        if (res.def.type === 'buffer') {
          const newSize = typeof size === 'number' ? size : size[0];
          if (res.data && res.data.length === newSize) return;
          res.width = newSize;
          res.data = new Array(newSize).fill(0);
        } else if (res.def.type === 'texture2d') {
          const width = Array.isArray(size) ? size[0] : size;
          const height = Array.isArray(size) ? size[1] : 1;
          res.width = width;
          res.height = height;

          if (format !== undefined) {
            if (typeof format === 'number') {
              const strFmt = TextureFormatFromId[format];
              if (strFmt) res.def.format = strFmt;
            } else {
              res.def.format = format as any;
            }
          }
          if (clear !== undefined) {
            res.data = new Array(width * height).fill(clear);
          }
        }
        if (this.ctx.logAction) this.ctx.logAction('resize', resId, { size, format });
      },
      log: (msg, payload) => {
        console.log(`[JIT Log] ${msg}`, payload);
        if (this.ctx.logAction) this.ctx.logAction('log', msg, payload);
      }
    };

    // Compiled signature: (resources, inputs, globals, variables)
    // We use context resources, global inputs, and current frame variables
    return await compiled(this.ctx.resources, this.ctx.inputs, globals, this.ctx.currentFrame.vars);
  }

  destroy() {
    this.webGpuExec.destroy();
  }
}

export const WebGpuBackend: TestBackend = {
  name: 'WebGPU',

  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map()) => {
    // 1. Create Context
    const ctx = new EvaluationContext(ir, inputs);

    // 2. Initialize GPU
    const device = await getSharedDevice();

    // attach device to context for easy access
    (ctx as any).device = device;

    return ctx;
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    await gpuSemaphore.acquire();
    let hostExec;
    try {
      const device = (ctx as any).device as GPUDevice;
      if (!device) throw new Error('Context missing GPUDevice');

      const gpuExec = new WebGpuExecutor(device, ctx.resources, ctx.inputs);
      await gpuExec.initialize(ctx.ir.functions, ctx.ir.resources, ctx.ir.structs);

      const func = ctx.ir.functions.find(f => f.id === entryPoint);
      if (!func) throw new Error(`Entry point '${entryPoint}' not found`);

      // 3. Execute
      if (func.type === 'cpu') {
        ctx.pushFrame(entryPoint);
        hostExec = new WebGpuHostExecutor(ctx, gpuExec);
        await hostExec.executeFunction(func, ctx.ir.functions);
      } else {
        // Direct shader execution
        const inputObj: Record<string, RuntimeValue> = {};
        ctx.inputs.forEach((v, k) => inputObj[k] = v);
        await gpuExec.executeShader(func, [1, 1, 1], inputObj);
      }
    } finally {
      hostExec?.destroy();
      gpuSemaphore.release();
    }
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await WebGpuBackend.createContext(ir, inputs);
    await WebGpuBackend.run(ctx, entryPoint);
    return ctx;
  }
};
