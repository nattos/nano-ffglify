import { IRDocument, ResourceDef, DataType, ResourceSize } from '../ir/types';

// ------------------------------------------------------------------
// Runtime Values
// ------------------------------------------------------------------
export type ScalarValue = number | boolean | string;
export type VectorValue = [number, number] | [number, number, number] | [number, number, number, number];
export type MatrixValue = number[]; // Simplified for now
export type RuntimeValue = ScalarValue | VectorValue | MatrixValue;

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

export interface ResourceState {
  def: ResourceDef;
  // In the simulator, a "buffer" is just an array of runtime values
  // A "texture" might just be metadata for now, or a simple 2D array
  data?: RuntimeValue[];
  width: number;
  height: number;
}

export interface StackFrame {
  name: string; // Function ID or Block
  vars: Map<string, RuntimeValue>;
  loopIndices: Map<string, number>; // LoopNodeID -> Current Index
}

export interface ActionLogEntry {
  type: 'dispatch' | 'draw' | 'resize' | 'log';
  target?: string;
  payload?: any;
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

  constructor(ir: IRDocument, inputs: Map<string, RuntimeValue>) {
    this.ir = ir;
    this.inputs = inputs;
    this.resources = new Map();

    // Initialize Resources (default state)
    for (const res of ir.resources) {
      this.resources.set(res.id, {
        def: res,
        width: 1, // Default, will be resized
        height: 1,
        data: [] // Initialize empty data
      });
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
      loopIndices: new Map()
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
}
