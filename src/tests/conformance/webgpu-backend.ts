/// <reference types="@webgpu/types" />
import { getSharedDevice, gpuSemaphore } from './gpu-singleton';

import type { TestBackend } from './types';
import { EvaluationContext } from '../../interpreter/context';
import { IRDocument } from '../../ir/types';
import { WebGpuHostExecutor } from '../../webgpu/webgpu-host-executor';
import { WebGpuHost } from '../../webgpu/webgpu-host';
import { RuntimeValue } from '../../webgpu/host-interface';
import { CpuJitCompiler } from '../../webgpu/cpu-jit';

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
    try {
      const device = (ctx as any).device as GPUDevice;
      if (!device) throw new Error('Context missing GPUDevice');

      const func = ctx.ir.functions.find(f => f.id === entryPoint);
      if (!func) throw new Error(`Entry point '${entryPoint}' not found`);

      // 3. Execute
      if (func.type === 'cpu') {
        ctx.pushFrame(entryPoint);

        const cpuJit = new CpuJitCompiler();
        const compiled = cpuJit.compile(ctx.ir, func.id);
        const gpuExecutor = await compiled.init(device);
        const webGpuHost = new WebGpuHost({
          device: device,
          executor: gpuExecutor,
          resources: ctx.resources,
          logHandler: (msg, payload) => ctx.log.push({ type: 'log', target: msg, payload }),
          onResizeCallback: (id, size, format) => {
            ctx.log.push({ type: 'resize', target: id, payload: { size, format } });
          }
        });

        const hostExec = new WebGpuHostExecutor({
          ir: ctx.ir,
          compiledCode: compiled,
          host: webGpuHost
        });
        ctx.result = await hostExec.execute(ctx.inputs);

        // Readback, for tests!
        for (const resourceId of ctx.resources.keys()) {
          webGpuHost.executeSyncToCpu(resourceId);
        }
        for (const resourceId of ctx.resources.keys()) {
          await webGpuHost.executeWaitCpuSync(resourceId);
        }
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
