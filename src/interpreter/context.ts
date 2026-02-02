import { IRDocument, ResourceDef, TextureFormat } from '../ir/types';
import type { RuntimeValue, ResourceState, ActionLogEntry } from '../ir/resource-store';

export type { RuntimeValue, VectorValue, ScalarValue, MatrixValue, ArrayValue, StructValue, ResourceState, ActionLogEntry } from '../ir/resource-store';

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

export interface StackFrame {
  name: string; // Function ID or Block
  vars: Map<string, RuntimeValue>;
  loopIndices: Map<string, number>;
  nodeResults: Map<string, RuntimeValue>;
}

export class EvaluationContext {
  ir: IRDocument;

  // Global State
  resources: Map<string, ResourceState>;
  inputs: Map<string, RuntimeValue>;

  // Execution Stack
  stack: StackFrame[] = [];

  // Builtin Globals (e.g. valid during Dispatch)
  builtins: Map<string, RuntimeValue> = new Map();

  // Side Effect Log
  log: ActionLogEntry[] = [];

  // Platform/Backend specific handles (e.g. GPUDevice)
  device?: any; // GPUDevice
  webGpuExec?: any; // WebGpuExecutor

  constructor(ir: IRDocument, inputs: Map<string, RuntimeValue>) {
    this.ir = ir;
    this.inputs = inputs;
    this.resources = new Map();

    // Initialize Resources (default state)
    for (const res of ir.resources) {
      let width = 1;
      let height = 1;

      if (res.size.mode === 'fixed') {
        const val = res.size.value;
        if (Array.isArray(val)) {
          width = val[0];
          height = val[1];
        } else {
          width = val;
        }
      }

      this.resources.set(res.id, {
        def: {
          ...res,
          format: res.format ?? TextureFormat.RGBA8 // Default texture format
        },
        width,
        height,
        data: [] // Data initialized lazily or on resize
      });

      // Apply clearVal if present
      if (res.persistence.clearValue !== undefined) {
        const r = this.resources.get(res.id)!;
        const count = width * height;
        r.data = new Array(count).fill(res.persistence.clearValue);
      }
    }

    // Treat 'texture2d' Inputs as Resources
    for (const inp of ir.inputs) {
      if (inp.type === 'texture2d') {
        this.resources.set(inp.id, {
          def: {
            id: inp.id,
            type: 'texture2d',
            size: { mode: 'fixed', value: [1, 1] },
            persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
          },
          width: 1,
          height: 1
        });
      }
    }
  }

  // -------------------------------------------------------
  // Stack Management
  // -------------------------------------------------------
  pushFrame(name: string) {
    this.stack.push({
      name,
      vars: new Map(),
      loopIndices: new Map(),
      nodeResults: new Map()
    });
  }

  popFrame() {
    this.stack.pop();
  }

  get currentFrame(): StackFrame {
    if (this.stack.length === 0) throw new Error("Runtime Error: Stack Underflow");
    return this.stack[this.stack.length - 1];
  }

  setVar(id: string, val: RuntimeValue) {
    this.currentFrame.vars.set(id, val);
  }

  getVar(id: string): RuntimeValue | undefined {
    // 1. Local Frame
    const val = this.currentFrame.vars.get(id);
    if (val !== undefined) return val;

    // 2. Builtins (GlobalInvocationID, etc.)
    const builtin = this.builtins.get(id);
    if (builtin !== undefined) return builtin;

    // 3. Inputs (Global constants/inputs)
    const input = this.inputs.get(id);
    if (input !== undefined) return input;

    return undefined;
  }

  setLoopIndex(loopId: string, idx: number) {
    this.currentFrame.loopIndices.set(loopId, idx);
  }

  getLoopIndex(loopId: string): number {
    const val = this.currentFrame.loopIndices.get(loopId);
    if (val === undefined) throw new Error(`Runtime Error: Loop '${loopId}' index not found in current frame`);
    return val;
  }

  // -------------------------------------------------------
  // Resources & Logging
  // -------------------------------------------------------

  logAction(type: ActionLogEntry['type'], target?: string, payload?: any) {
    this.log.push({ type, target, payload });
  }

  getResource(id: string): ResourceState {
    const res = this.resources.get(id);
    if (!res) throw new Error(`Runtime Error: Resource '${id}' not found`);
    return res;
  }

  getInput(id: string): RuntimeValue {
    const val = this.inputs.get(id);
    if (val === undefined) {
      // Try find default
      const def = this.ir.inputs.find(i => i.id === id);
      if (def?.default !== undefined) return def.default;
      throw new Error(`Runtime Error: Input '${id}' not provided`);
    }
    return val;
  }

  /**
   * Cleanup backend resources
   */
  destroy() {
    // 1. Cleanup Resource Handles (GPU Buffers/Textures)
    this.resources.forEach(state => {
      if ((state as any).gpuBuffer && typeof (state as any).gpuBuffer.destroy === 'function') {
        (state as any).gpuBuffer.destroy();
        (state as any).gpuBuffer = undefined;
      }
      if ((state as any).gpuTexture && typeof (state as any).gpuTexture.destroy === 'function') {
        (state as any).gpuTexture.destroy();
        (state as any).gpuTexture = undefined;
      }
    });

    // 2. Cleanup Backend Specific
    if (this.webGpuExec && typeof this.webGpuExec.destroy === 'function') {
      this.webGpuExec.destroy();
      this.webGpuExec = undefined;
    }

    // Note: We don't destroy the device here because it might be shared (e.g. in tests)
    // or managed by a higher-level executor.
    this.device = undefined;
  }
}
