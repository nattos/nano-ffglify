/**
 * Test-card renderer that compiles and executes the real TEST_CARD_SHADER
 * IRDocument from example-ir.ts.  GPU pipelines are cached per device;
 * each render() call creates lightweight resources, maps the target
 * texture as 'output', executes the IR, and cleans up.
 */

import { CpuJitCompiler, CompiledJitResult } from '../webgpu/cpu-jit';
import { makeResourceStates } from './resources';
import { WebGpuHost, IGpuExecutor } from '../webgpu/webgpu-host';
import { WebGpuHostExecutor } from '../webgpu/webgpu-host-executor';
import { TEST_CARD_SHADER } from '../domain/example-ir';
import { RuntimeValue } from '../webgpu/host-interface';

export class TestCardRenderer {
  private compiledCode: CompiledJitResult | null = null;
  private gpuExecutor: IGpuExecutor | null = null;
  private cachedDevice: GPUDevice | null = null;

  async render(device: GPUDevice, texture: GPUTexture, number: number, time: number = 0) {
    await this.ensureCompiled(device);

    // Fresh resources from the real IR definition
    const resources = makeResourceStates(TEST_CARD_SHADER);

    // Map the target texture as the 'output' resource
    const outputRes = resources.get('output')!;
    outputRes.gpuTexture = texture;
    outputRes.width = texture.width;
    outputRes.height = texture.height;

    const inputs = new Map<string, RuntimeValue>([['u_number', number]]);

    const host = new WebGpuHost({
      device,
      executor: this.gpuExecutor!,
      resources,
      inputs,
    });

    const executor = new WebGpuHostExecutor({
      ir: TEST_CARD_SHADER,
      compiledCode: this.compiledCode!,
      host,
    });

    executor.setBuiltins({ time });
    await executor.execute(inputs);

    // Clean up the temporary grid_params GPU buffer (output texture is not ours)
    const gridParams = resources.get('grid_params');
    if (gridParams?.gpuBuffer) {
      gridParams.gpuBuffer.destroy();
    }
  }

  private async ensureCompiled(device: GPUDevice) {
    if (!this.compiledCode) {
      const cpuJit = new CpuJitCompiler();
      this.compiledCode = cpuJit.compile(TEST_CARD_SHADER, TEST_CARD_SHADER.entryPoint);
    }
    if (!this.gpuExecutor || this.cachedDevice !== device) {
      this.gpuExecutor = await this.compiledCode.init(device);
      this.cachedDevice = device;
    }
  }

  destroy() {
    this.compiledCode = null;
    this.gpuExecutor = null;
    this.cachedDevice = null;
  }
}
