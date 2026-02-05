import { IRDocument } from '../ir/types';
import { makeResourceStates } from '../runtime/resources';
import { CompiledJitResult } from './cpu-jit';
import { ResourceState, RuntimeValue } from './host-interface';
import { WebGpuHost } from './webgpu-host';

/**
 * A simple wrapper to help coordinate executing compiled WebGPU (JS + WGSL) code.
 */
export class WebGpuHostExecutor {
  readonly compiledCode: CompiledJitResult;
  readonly host: WebGpuHost;
  readonly resources: Map<string, ResourceState>;

  constructor(init: {
    ir: IRDocument;
    compiledCode: CompiledJitResult;
    host: WebGpuHost;
  }) {
    this.compiledCode = init.compiledCode;
    this.host = init.host;
    this.resources = makeResourceStates(init.ir);
  }

  async execute(inputs: Map<string, RuntimeValue>): Promise<RuntimeValue> {
    // Run the task function with the initialized executor
    const result = await this.compiledCode.task({
      resources: this.host.resources,
      inputs: inputs,
      globals: this.host
    });
    return result;
  }
}
