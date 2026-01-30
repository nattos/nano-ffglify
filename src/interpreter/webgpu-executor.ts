import { IRDocument, FunctionDef } from '../ir/types';
import { EvaluationContext, RuntimeValue } from './context';
import { globals } from 'webgpu';
import { CpuJitCompiler } from './cpu-jit';
import { OpRegistry } from './ops';
import { BuiltinOp, TextureFormatValues, TextureFormatFromId, TextureFormat } from '../ir/types';

// Helper to polyfill if needed, similar to test
function ensureGpuGlobals() {
  if (typeof global !== 'undefined' && !global.GPUBufferUsage) {
    Object.assign(global, globals);
  }
}

export class WebGpuExecutor {
  device: GPUDevice;
  context: EvaluationContext;

  // Cache for compiled shader modules?
  private shaderCache: Map<string, GPUShaderModule> = new Map();
  private pipelineCache: Map<string, GPUComputePipeline> = new Map();

  constructor(device: GPUDevice, context: EvaluationContext) {
    this.device = device;
    this.context = context;
    ensureGpuGlobals();
  }

  /**
   * Unimplemented: Transpile IR Function to WGSL
   */
  private compileWgsl(func: FunctionDef): string {
    // TODO: Implement WGSL Generator (irToWgsl)
    // For now, return a placeholder or throw
    throw new Error('WGSL Generation not implemented');
  }

  /**
   * Execute a "Compute" function on the GPU.
   * This corresponds to a 'cmd_dispatch' call from the host,
   * or a direct entry point execution if the entry point is a shader.
   */
  async executeShader(funcId: string, workgroups: [number, number, number]) {
    const func = this.context.ir.functions.find(f => f.id === funcId);
    if (!func) throw new Error(`Function '${funcId}' not found`);
    if (func.type !== 'shader') throw new Error(`Function '${funcId}' is not a shader`);

    // 1. Get/Compile Pieline
    // 1. Get/Compile Pieline
    let pipeline = this.pipelineCache.get(funcId);
    if (!pipeline) {
      try {
        const code = this.compileWgsl(func);
        const module = this.device.createShaderModule({
          label: funcId,
          code: code
        });
        pipeline = this.device.createComputePipeline({
          label: `${funcId}_pipeline`,
          layout: 'auto',
          compute: { module, entryPoint: 'main' } // assuming main
        });
        this.pipelineCache.set(funcId, pipeline);
      } catch (e: any) {
        if (e.message.includes('not implemented')) {
          console.warn(`[WebGpuExecutor] WGSL Gen not implemented for ${funcId}, falling back to CPU JIT`);
          return this.executeShaderCpu(funcId, workgroups);
        }
        throw e;
      }
    }

    // 2. Create BindGroup
    // TODO: Map context resources to BindGroup entries based on function signature/usage
    // const bindGroup = ...

    // 3. Dispatch
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    // pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(...workgroups);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }

  private executeShaderCpu(funcId: string, workgroups: [number, number, number]) {
    const func = this.context.ir.functions.find(f => f.id === funcId);
    if (!func) throw new Error(`Function '${funcId}' not found`);

    const jit = new CpuJitCompiler();
    const compiled = jit.compile(func);
    let globalId = [0, 0, 0];

    const shaderGlobals = {
      callOp: (op: string, args: any) => {
        const handler = OpRegistry[op as BuiltinOp];
        if (!handler) throw new Error(`Op not found: ${op}`);
        return handler(this.context, args);
      },
      resolveString: (val: string) => {
        try {
          return this.context.getInput(val);
        } catch {
          return val;
        }
      },
      resolveVar: (val: string) => {
        // Builtins
        if (val === 'GlobalInvocationID') return [...globalId];

        const v = this.context.getVar(val);
        if (v !== undefined) return v;
        try {
          return this.context.getInput(val);
        } catch {
          throw new Error(`Runtime Error: Variable '${val}' is not defined`);
        }
      },
      resize: (resId: string, size: number | number[], format?: string | number, clear?: number | number[]) => {
        // Same logic as HostExecutor
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
            if (this.context.logAction) {
              this.context.logAction('resize', resId, { size: [width, height], format: res.def.format });
            }
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
            const v = clear;
            res.data = new Array(width * height).fill(v);
          }
        }
      },
      bufferLoad: (bufId: string, idx: number) => {
        const res = this.context.getResource(bufId);
        if (!res.data) return 0;
        if (idx < 0 || idx >= res.width) throw new Error('Runtime Error: buffer_load OOB');
        return res.data[idx] ?? 0;
      },
      callFunc: (targetId: string, args: any) => {
        // Naive recursion support if needed?
        // This is a shader, callFunc usually means helper function.
        // We can recurse via executeShaderCpu or just execute function logic?
        // Helper functions should be compiled too.
        // But `callFunc` here assumes it runs another function.
        // We can create a new JIT instance/cache?
        // MVP: Recursive call via JIT compilation
        // For now, minimal support or throw if shader calls functions (unlikely in conformance tests currently).
        throw new Error('Recursion in shader emulation not fully implemented');
      },
      dispatch: (targetId: string, wg: any) => {
        return this.executeShader(targetId, wg);
      }
    };

    const [gx, gy, gz] = workgroups;
    // Emulate Dispatch Loop
    for (let z = 0; z < gz; z++) {
      for (let y = 0; y < gy; y++) {
        for (let x = 0; x < gx; x++) {
          globalId = [x, y, z];
          compiled(this.context, this.context.resources, shaderGlobals);
        }
      }
    }
  }
}
