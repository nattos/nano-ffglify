import { EvaluationContext, RuntimeValue } from '../interpreter/context';
import { WebGpuExecutor } from './webgpu-executor';
import { FunctionDef, IRDocument } from '../ir/types';
import { CompiledJitResult, CpuJitCompiler } from './cpu-jit';
import { WebGpuHost } from './webgpu-host';

/**
 * Orchestrates JIT-compiled CPU functions with the WebGpuExecutor.
 */
export class WebGpuHostExecutor {
  webGpuExec: WebGpuExecutor;
  ctx: EvaluationContext;
  jit: CpuJitCompiler;
  compiledCache: Map<string, CompiledJitResult> = new Map(); // Stores JitResult

  constructor(ctx: EvaluationContext, webGpuExec: WebGpuExecutor) {
    this.ctx = ctx;
    this.webGpuExec = webGpuExec;
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
    const gpuExecutor = await compiled.init(this.webGpuExec.device);
    const webGpuHost = new WebGpuHost({
      executor: gpuExecutor,
      resources: this.ctx.resources,
    });

    // Run the task function with the initialized executor
    return await compiled.task({ resources: this.ctx.resources, inputs: this.ctx.inputs, globals: webGpuHost });
  }

  destroy() {
    this.webGpuExec.destroy();
  }
}
