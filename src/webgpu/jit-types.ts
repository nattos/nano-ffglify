import { ResourceState, RuntimeValue } from './host-interface';
import { IGpuExecutor, WebGpuHost } from './webgpu-host';

export interface Builtins {
  time: number;
  delta_time: number;
  bpm: number;
  beat_number: number;
  beat_delta: number;
}

export interface JitContext {
  resources: Map<string, ResourceState>;
  inputs: Map<string, RuntimeValue>;
  globals: WebGpuHost;
  builtins: Builtins;
}

export type CompiledTaskFunction = (ctx: JitContext) => Promise<RuntimeValue>;
export type CompiledInitFunction = (device: GPUDevice) => Promise<IGpuExecutor>;
