import { IRDocument, FunctionDef, ResourceDef } from '../ir/types';
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

  private shaderCache: Map<string, GPUShaderModule> = new Map();
  private pipelineCache: Map<string, GPUComputePipeline> = new Map();

  constructor(device: GPUDevice, context: EvaluationContext) {
    this.device = device;
    this.context = context;
    ensureGpuGlobals();
  }

  /**
   * Pre-compile all shaders in the IR document.
   */
  async initialize() {
    const ir = this.context.ir;
    const generator = new (await import('../compiler/wgsl/wgsl-generator')).WgslGenerator();

    for (const func of ir.functions) {
      if (func.type !== 'shader') continue;

      try {
        // Options for compilation
        // We use binding 0 for globals (if needed) and binding 1 for inputs
        const options = {
          inputBinding: 1,
          resourceBindings: new Map<string, number>(),
          resourceDefs: new Map<string, ResourceDef>(),
        };

        // Map resources used in this function to bindings starting from index 2
        let bindingIdx = 2;
        ir.resources.forEach(res => {
          options.resourceBindings!.set(res.id, bindingIdx++);
          options.resourceDefs!.set(res.id, res);
        });

        const code = generator.compile(ir, func.id, options);
        const module = this.device.createShaderModule({
          label: func.id,
          code: code
        });

        const pipeline = await this.device.createComputePipelineAsync({
          label: `${func.id}_pipeline`,
          layout: 'auto',
          compute: { module, entryPoint: 'main' }
        });

        this.shaderCache.set(func.id, module);
        this.pipelineCache.set(func.id, pipeline);
      } catch (e: any) {
        console.error(`Failed to compile shader ${func.id}:`);
        console.error(e.message);
        // If it was a compilation info error, we already printed it? No, creating module doesn't throw usually.
        // Pipeline creation might.
      }
    }
  }

  /**
   * Unimplemented: Transpilation is now done in initialize.
   */
  private compileWgsl(func: FunctionDef): string {
    throw new Error('WGSL should be pre-compiled in initialize()');
  }

  /**
   * Execute a "Compute" function on the GPU.
   */
  async executeShader(funcId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue> = {}) {
    const func = this.context.ir.functions.find(f => f.id === funcId);
    if (!func) throw new Error(`Function '${funcId}' not found`);
    if (func.type !== 'shader') throw new Error(`Function '${funcId}' is not a shader`);

    // 1. Get Pipeline
    const pipeline = this.pipelineCache.get(funcId);
    if (!pipeline) {
      console.warn(`[WebGpuExecutor] No pre-compiled pipeline for ${funcId}, falling back to CPU JIT`);
      return this.executeShaderCpu(funcId, workgroups, args);
    }

    // 2. Prepare Inputs Buffer
    let bindGroup: GPUBindGroup | undefined;
    if (func.inputs.length > 0) {
      const bufferData = this.packArguments(func.inputs, args);
      const inputBuffer = this.device.createBuffer({
        label: `${funcId}_inputs`,
        size: bufferData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(inputBuffer, 0, bufferData);

      // 3. Create BindGroup
      const entries: GPUBindGroupEntry[] = [
        { binding: 1, resource: { buffer: inputBuffer } }
      ];

      // Add resource bindings
      this.context.ir.resources.forEach((res, idx) => {
        // Find binding idx from generator logic (starts at 2)
        const binding = 2 + this.context.ir.resources.indexOf(res);
        const resource = this.context.getResource(res.id);
        // Map to GPU resource (currently tests use CPU data, we need GPU buffers)
        // For conformance testing, we might need to sync CPU -> GPU here.
        // TODO: Persistent GPU buffers for resources
      });

      // Special: Conformance tests often use a single result buffer.
      // Let's check for 'b_res' or 'b_result' and bind it if it exists.
      this.context.ir.resources.forEach((res, idx) => {
        const binding = 2 + idx;
        const state = this.context.getResource(res.id);

        // Ensure GPU buffer exists
        if (!(state as any).gpuBuffer) {
          (state as any).gpuBuffer = this.device.createBuffer({
            label: res.id,
            size: Math.max(state.width * 4, 16), // Simplified: 4 bytes per float
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
          });
          // Sync initial data if any
          if (state.data) {
            const flat = (state.data as any).flat(2) as number[];
            this.device.queue.writeBuffer((state as any).gpuBuffer, 0, new Float32Array(flat));
          }
        }

        entries.push({ binding, resource: { buffer: (state as any).gpuBuffer } });
      });

      bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries
      });
    }

    // 4. Dispatch
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    if (bindGroup) pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(...workgroups);
    pass.end();

    // 5. Read-back (Important for conformance tests)
    const stagingBuffers: { id: string, staging: GPUBuffer }[] = [];
    this.context.ir.resources.forEach(res => {
      const state = this.context.getResource(res.id);
      const gpuBuffer = (state as any).gpuBuffer as GPUBuffer;
      if (gpuBuffer) {
        const staging = this.device.createBuffer({
          size: gpuBuffer.size,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        encoder.copyBufferToBuffer(gpuBuffer, 0, staging, 0, gpuBuffer.size);
        stagingBuffers.push({ id: res.id, staging });
      }
    });

    this.device.queue.submit([encoder.finish()]);

    // 6. Wait for results and sync to Context
    await Promise.all(stagingBuffers.map(async ({ id, staging }) => {
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange());
      const state = this.context.getResource(id);
      // Simplified: always sync as float array
      state.data = Array.from(data);
      staging.unmap();
    }));
  }

  private packArguments(inputs: { id: string, type: string }[], args: Record<string, RuntimeValue>): ArrayBuffer {
    let offset = 0;
    const packedData: { offset: number, value: RuntimeValue, type: string }[] = [];

    for (const input of inputs) {
      const align = this.getAlignment(input.type);
      const size = this.getSize(input.type);
      offset = Math.ceil(offset / align) * align;
      packedData.push({ offset, value: args[input.id], type: input.type });
      offset += size;
    }

    const buffer = new ArrayBuffer(Math.ceil(offset / 16) * 16);
    const view = new DataView(buffer);
    for (const item of packedData) {
      this.writeToBuffer(view, item.offset, item.value, item.type);
    }
    return buffer;
  }

  private getAlignment(type: string): number {
    if (type === 'float' || type === 'int' || type === 'bool' || type === 'f32' || type === 'i32') return 4;
    if (type === 'float2' || type === 'vec2<f32>') return 8;
    return 16; // vec3, vec4, mat, etc.
  }

  private getSize(type: string): number {
    if (type === 'float' || type === 'int' || type === 'bool' || type === 'f32' || type === 'i32') return 4;
    if (type === 'float2' || type === 'vec2<f32>') return 8;
    if (type === 'float3' || type === 'vec3<f32>' || type === 'float4' || type === 'vec4<f32>') return 16;
    if (type === 'float3x3' || type === 'mat3x3<f32>') return 48;
    if (type === 'float4x4' || type === 'mat4x4<f32>') return 64;
    return 4;
  }

  private writeToBuffer(view: DataView, offset: number, val: RuntimeValue, type: string) {
    if (typeof val === 'number') {
      if (type === 'int' || type === 'i32') view.setInt32(offset, val, true);
      else view.setFloat32(offset, val, true);
    } else if (typeof val === 'boolean') {
      view.setInt32(offset, val ? 1 : 0, true);
    } else if (Array.isArray(val)) {
      if (type.startsWith('mat')) {
        const dim = type.includes('3x3') ? 3 : 4;
        for (let c = 0; c < dim; c++) {
          for (let r = 0; r < dim; r++) {
            view.setFloat32(offset + (c * 16) + (r * 4), val[c * dim + r] as number, true);
          }
        }
      } else {
        for (let i = 0; i < val.length; i++) {
          view.setFloat32(offset + (i * 4), val[i] as number, true);
        }
      }
    }
  }

  private executeShaderCpu(funcId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue> = {}) {
    const func = this.context.ir.functions.find(f => f.id === funcId);
    if (!func) throw new Error(`Function '${funcId}' not found`);

    const jit = new CpuJitCompiler();
    const compiled = jit.compile(func);
    let globalId = [0, 0, 0];

    // Set variables in context for function arguments
    this.context.pushFrame(funcId);
    for (const [key, val] of Object.entries(args)) {
      if (key !== 'func' && key !== 'dispatch' && key !== 'comment' && typeof val === 'string') {
        throw new Error(`Runtime Error: String marshalling to shader not supported (arg: ${key})`);
      }
      this.context.setVar(key, val);
    }

    const shaderGlobals = {
      callOp: (op: string, args: any) => {
        const handler = OpRegistry[op as BuiltinOp];
        if (!handler) throw new Error(`Op not found: ${op}`);
        return handler(this.context, args);
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

    this.context.popFrame();
  }
}
