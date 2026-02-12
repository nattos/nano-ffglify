import { IRDocument } from '../ir/types';
import { makeResourceStates } from '../runtime/resources';
import { CompiledJitResult } from './cpu-jit';
import { Builtins } from './jit-types';
import { ResourceState, RuntimeValue } from './host-interface';
import { WebGpuHost } from './webgpu-host';

/**
 * A simple wrapper to help coordinate executing compiled WebGPU (JS + WGSL) code.
 */
export class WebGpuHostExecutor {
  readonly compiledCode: CompiledJitResult;
  readonly host: WebGpuHost;
  readonly resources: Map<string, ResourceState>;
  private builtins: Builtins = {
    time: 0,
    delta_time: 0,
    bpm: 0,
    beat_number: 0,
    beat_delta: 0
  };

  constructor(init: {
    ir: IRDocument;
    compiledCode: CompiledJitResult;
    host: WebGpuHost;
  }) {
    this.compiledCode = init.compiledCode;
    this.host = init.host;
    this.resources = makeResourceStates(init.ir);
  }

  setBuiltins(builtins: Partial<Builtins>) {
    this.builtins = { ...this.builtins, ...builtins };
  }

  async execute(inputs: Map<string, RuntimeValue>): Promise<RuntimeValue> {
    // Run the task function with the initialized executor
    const result = await this.compiledCode.task({
      resources: this.host.resources,
      inputs: inputs,
      globals: this.host,
      builtins: this.builtins
    });
    return result;
  }
}
