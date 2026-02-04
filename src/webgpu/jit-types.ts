import { RuntimeValue, ResourceState } from '../interpreter/context';
import { WebGpuHost } from './webgpu-host';

export interface JitContext {
  resources: Map<string, ResourceState>;
  inputs: Map<string, RuntimeValue>;
  globals: WebGpuHost;
}

export type CompiledTaskFunction = (ctx: JitContext) => Promise<RuntimeValue>;
