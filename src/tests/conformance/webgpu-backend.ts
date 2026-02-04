/// <reference types="@webgpu/types" />
import { getSharedDevice, gpuSemaphore } from './gpu-singleton';

import type { TestBackend } from './types';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { IRDocument } from '../../ir/types';
import { WebGpuHostExecutor } from '../../webgpu/webgpu-host-executor';

/**
 * A full backend that runs both CPU and GPU code.
 *
 * CPU code is transformed into JavaScript, and GPU code is translated into
 * WGSL, with WebGPU bindings to dispatch shaders.
 */
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

      const func = ctx.ir.functions.find(f => f.id === entryPoint);
      if (!func) throw new Error(`Entry point '${entryPoint}' not found`);

      // 3. Execute
      if (func.type === 'cpu') {
        ctx.pushFrame(entryPoint);
        hostExec = new WebGpuHostExecutor(ctx, device);
        ctx.result = await hostExec.executeFunction(func, ctx.ir.functions);
      } else {
        throw new Error(`Entry point '${entryPoint}' must be 'cpu'`);
      }
    } finally {
      gpuSemaphore.release();
    }
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await WebGpuBackend.createContext(ir, inputs);
    await WebGpuBackend.run(ctx, entryPoint);
    return ctx;
  }
};
