import { EvaluationContext, RuntimeValue } from '../interpreter/context';
import { FunctionDef, IRDocument } from '../ir/types';
import { CompiledJitResult, CpuJitCompiler } from './cpu-jit';
import { WebGpuHost } from './webgpu-host';

/**
 * Orchestrates JIT-compiled CPU functions with the WebGpuExecutor.
 */
export class WebGpuHostExecutor {
  device: GPUDevice;
  ctx: EvaluationContext;
  jit: CpuJitCompiler;
  compiledCache: Map<string, CompiledJitResult> = new Map(); // Stores JitResult

  constructor(ctx: EvaluationContext, device: GPUDevice) {
    this.ctx = ctx;
    this.device = device;
    this.jit = new CpuJitCompiler();
  }

  async executeFunction(func: FunctionDef, functions: FunctionDef[]): Promise<RuntimeValue> {
    let compiled = this.compiledCache.get(func.id);
    if (!compiled) {
      compiled = this.jit.compile(this.ctx.ir, func.id);
      this.compiledCache.set(func.id, compiled);
    }

    // Initialize the GPU executor structure for this specific graph
    // compiled.init returns Promise<IGpuExecutor>
    const gpuExecutor = await compiled.init(this.device);
    const webGpuHost = new WebGpuHost({
      executor: gpuExecutor,
      resources: this.ctx.resources,
      logHandler: (msg, payload) => this.ctx.log.push({ type: 'log', target: msg, payload }),
      onResizeCallback: (id, size, format) => {
        this.ctx.log.push({ type: 'resize', target: id, payload: { size, format } });
      }
    });

    // Run the task function with the initialized executor
    const result = await compiled.task({ resources: this.ctx.resources, inputs: this.ctx.inputs, globals: webGpuHost });

    for (const resourceId of this.ctx.resources.keys()) {
      webGpuHost.executeSyncToCpu(resourceId);
    }
    for (const resourceId of this.ctx.resources.keys()) {
      await webGpuHost.executeWaitCpuSync(resourceId);
    }

    return result;
  }
}
