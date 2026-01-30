import type { TestBackend } from './test-runner';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { InterpretedExecutor } from '../../interpreter/executor';
import { WebGpuExecutor } from '../../interpreter/webgpu-executor';
import { IRDocument, Node, FunctionDef, TextureFormatFromId } from '../../ir/types';
import { create, globals } from 'webgpu';

// Ensure globals
if (typeof global !== 'undefined' && !global.GPUBufferUsage) {
  Object.assign(global, globals);
}

import { CpuJitCompiler } from '../../interpreter/cpu-jit';

import { OpRegistry } from '../../interpreter/ops';

class WebGpuHostExecutor {
  webGpuExec: WebGpuExecutor;
  context: EvaluationContext;
  jit: CpuJitCompiler;
  compiledCache: Map<string, Function> = new Map();
  pending: Promise<any>[] = [];

  constructor(context: EvaluationContext, webGpuExec: WebGpuExecutor) {
    this.context = context;
    this.webGpuExec = webGpuExec;
    this.jit = new CpuJitCompiler();
  }

  executeFunction(func: FunctionDef) {
    let compiled = this.compiledCache.get(func.id);
    if (!compiled) {
      compiled = this.jit.compile(func);
      this.compiledCache.set(func.id, compiled);
    }

    // Prepare Globals (Dispatch Interface & Ops)
    const globals = {
      dispatch: (targetId: string, dim: [number, number, number], args: Record<string, RuntimeValue> = {}) => {
        // Dispatch to GPU
        // Track the async promise so we can await it later
        const p = this.webGpuExec.executeShader(targetId, dim, args);
        this.pending.push(p);
      },
      callOp: (opName: string, args: Record<string, RuntimeValue>) => {
        const handler = OpRegistry[opName as keyof typeof OpRegistry];
        if (handler) {
          return handler(this.context, args);
        }
        console.warn(`JIT Warning: implementation of '${opName}' not found or not registered.`);
        return 0;
      },
      resolveString: (val: string) => {
        const v = this.context.getVar(val);
        if (v !== undefined) return v;
        try {
          return this.context.getInput(val);
        } catch {
          return val;
        }
      },
      resolveVar: (val: string) => {
        const v = this.context.getVar(val);
        if (v !== undefined) return v;
        try {
          return this.context.getInput(val);
        } catch {
          throw new Error(`Runtime Error: Variable '${val}' is not defined`);
        }
      },
      resize: (resId: string, size: number | number[], format?: string | number, clear?: number | number[]) => {
        const res = this.context.getResource(resId);
        if (res.def.type === 'buffer') {
          const newSize = typeof size === 'number' ? size : size[0];
          if (res.data && res.data.length === newSize) return;
          res.width = newSize;
          res.data = new Array(newSize).fill(0);
          if (this.context.logAction) {
            this.context.logAction('resize', resId, { size: newSize, format: 'buffer' });
          }
        } else if (res.def.type === 'texture2d') {
          const width = Array.isArray(size) ? size[0] : size as number;
          const height = Array.isArray(size) ? size[1] : 1;
          if (res.width !== width || res.height !== height) {
            res.width = width;
            res.height = height;
            if (res.def.persistence.clearOnResize) {
              const v = res.def.persistence.clearValue ?? [0, 0, 0, 0];
              res.data = new Array(width * height).fill(v);
            }
          }
          if (this.context.logAction) {
            this.context.logAction('resize', resId, { size: [width, height], format: res.def.format });
          }

          // Format Update


          // Format Update
          if (format !== undefined) {
            if (typeof format === 'number') {
              const strFmt = TextureFormatFromId[format];
              if (strFmt) res.def.format = strFmt;
            } else {
              res.def.format = format as any;
            }
          }

          // Explicit Clear
          if (clear !== undefined) {
            const v = clear;
            res.data = new Array(width * height).fill(v);
          }
        }
      },
      bufferLoad: (bufId: string, idx: number) => {
        const res = this.context.getResource(bufId);
        if (!res.data) return 0;
        if (idx < 0 || idx >= res.width) {
          throw new Error('Runtime Error: buffer_load OOB');
        }
        return res.data[idx] ?? 0;
      },
      callFunc: (targetId: string, args: Record<string, RuntimeValue>) => {
        const targetFunc = this.context.ir.functions.find(f => f.id === targetId);
        if (!targetFunc) throw new Error(`Function '${targetId}' not found`);

        this.context.pushFrame(targetId);
        if (targetFunc.inputs) {
          for (const inputDef of targetFunc.inputs) {
            const val = args[inputDef.id];
            if (val !== undefined) this.context.setVar(inputDef.id, val);
          }
        }

        try {
          const ret = this.executeFunction(targetFunc);
          this.context.popFrame();
          return ret;
        } catch (e: any) {
          if (e instanceof RangeError && e.message.includes('call stack')) {
            throw new Error('Recursion detected');
          }
          throw e;
        }
      }
    };

    // Prepare Resources (ctx.resources is Map<string, Resource>)
    // JIT might assume resources is the map itself.
    // JIT code: `ctx.getResource(id).data[...]`
    // So passing `ctx` is sufficient if access ref is compiled as `ctx.getResource`.
    // My JIT emits `ctx.getResource(...)`.

    // Execute
    return compiled(this.context, this.context.resources, globals);
  }
}

export const WebGpuBackend: TestBackend = {
  name: 'WebGPU',

  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map()) => {
    // 1. Create Context
    const ctx = new EvaluationContext(ir, inputs);

    // 2. Initialize GPU
    const entry = create([]);
    const adapter = await entry.requestAdapter();
    if (!adapter) throw new Error('No WebGPU Adapter found');
    const device = await adapter.requestDevice();

    // attach device to context for easy access if needed (hacky but effective)
    (ctx as any).device = device;

    // 3. Initialize Resources on GPU
    // TODO: allocate buffers

    return ctx;
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    const device = (ctx as any).device as GPUDevice;
    if (!device) throw new Error('Context missing GPUDevice');

    const gpuExec = new WebGpuExecutor(device, ctx);
    await gpuExec.initialize();
    const hostExec = new WebGpuHostExecutor(ctx, gpuExec);

    const func = ctx.ir.functions.find(f => f.id === entryPoint);
    if (!func) throw new Error(`Entry point '${entryPoint}' not found`);

    // Only support CPU entry point for now (Host Logic)
    if (func.type === 'cpu') {
      ctx.pushFrame(entryPoint);
      hostExec.executeFunction(func);
      if (hostExec.pending.length > 0) {
        await Promise.all(hostExec.pending);
      }
    } else {
      // Direct shader execution - usually tests use a wrapper 'main'
      // If entry point is shader, we dispatch (1,1,1)?
      await gpuExec.executeShader(entryPoint, [1, 1, 1]);
    }
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await WebGpuBackend.createContext(ir, inputs);
    await WebGpuBackend.run(ctx, entryPoint);
    return ctx;
  }
};
