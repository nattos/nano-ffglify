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
  resources: Map<string, ResourceState>;
  inputs: Map<string, RuntimeValue>;
  variables: Map<string, RuntimeValue>;
  jit: CpuJitCompiler;
  compiledCache: Map<string, Function> = new Map();
  logAction?: (type: string, id: string, payload: any) => void;
  device: GPUDevice;

  constructor(resources: Map<string, ResourceState>, inputs: Map<string, RuntimeValue>, variables: Map<string, RuntimeValue>, webGpuExec: WebGpuExecutor, logAction?: any) {
    this.resources = resources;
    this.inputs = inputs;
    this.variables = variables;
    this.webGpuExec = webGpuExec;
    this.logAction = logAction;
    this.jit = new CpuJitCompiler();
    this.device = webGpuExec.device;
  }

  async executeFunction(func: FunctionDef, functions: FunctionDef[]) {
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
        await this.webGpuExec.executeDraw(targetId, vertexId, fragmentId, count, pipeline, Array.from(this.resources.values()).map(r => r.def));
      },
      callOp: (opName, args) => {
        const handler = (HostOps as any)[opName];
        if (handler) return handler(args);
        console.warn(`JIT Warning: Host implementation of '${opName}' not found. Available:`, Object.keys(HostOps));
        return 0;
      },
      resolveString: (val) => {
        if (this.inputs.has(val)) return this.inputs.get(val)!;
        return val;
      },
      resolveVar: (val) => {
        if (this.inputs.has(val)) return this.inputs.get(val)!;
        throw new Error(`Runtime Error: Input variable '${val}' is not defined`);
      },
      resize: (resId, size, format, clear) => {
        const res = this.resources.get(resId);
        if (!res) throw new Error(`Resource '${resId}' not found`);
        if (res.def.type === 'buffer') {
          const newSize = typeof size === 'number' ? size : size[0];
          if (res.data && res.data.length === newSize) return;
          res.width = newSize;
          res.data = new Array(newSize).fill(0);
        } else if (res.def.type === 'texture2d') {
          const width = Array.isArray(size) ? size[0] : size;
          const height = Array.isArray(size) ? size[1] : 1;
          if (res.width !== width || res.height !== height) {
            res.width = width;
            res.height = height;
          }
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
        if (this.logAction) this.logAction('resize', resId, { size, format });
      },
      log: (msg, payload) => {
        console.log(`[JIT Log] ${msg}`, payload);
        if (this.logAction) this.logAction('log', msg, payload);
      }
    };

    // Execute
    return await compiled(this.resources, this.inputs, globals, this.variables);
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
        hostExec = new WebGpuHostExecutor(ctx.resources, ctx.inputs, ctx.currentFrame.vars, gpuExec, ctx.logAction?.bind(ctx));
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
