import { EvaluationContext, RuntimeValue } from '../interpreter/context';
import { WebGpuExecutor } from './webgpu-executor';
import { FunctionDef, IRDocument } from '../ir/types';
import { CpuJitCompiler } from './cpu-jit';
import { WebGpuHost } from './webgpu-host';

/**
 * Orchestrates JIT-compiled CPU functions with the WebGpuExecutor.
 */
export class WebGpuHostExecutor {
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
      compiled = this.jit.compile(this.ctx.ir, func.id);
      this.compiledCache.set(func.id, compiled);
    }

    const hostGlobals = new WebGpuHost({
      executeShader: async (targetId, dim, args) => {
        const targetFunc = functions.find(f => f.id === targetId);
        if (!targetFunc) throw new Error(`Shader '${targetId}' not found`);
        await this.webGpuExec.executeShader(targetFunc, dim, args);
      },
      executeDraw: async (targetId, vertexId, fragmentId, count, pipeline) => {
        const resources = Array.from(this.ctx.resources.values()).map(r => r.def);
        await this.webGpuExec.executeDraw(targetId, vertexId, fragmentId, count, pipeline as any, resources as any);
      }
    }, this.ctx.resources as any, (resId, size, format) => {
      this.ctx.logAction('resize', resId, { size, format });
    }, (msg, payload) => {
      this.ctx.logAction('log', msg, payload);
    });

    // Compiled signature: (resources, inputs, globals, variables)
    // We use context resources, global inputs, and current frame variables
    return await compiled(this.ctx.resources, this.ctx.inputs, hostGlobals);
  }

  destroy() {
    this.webGpuExec.destroy();
  }
}
