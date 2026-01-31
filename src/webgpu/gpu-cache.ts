export class GpuCache {
  private static shaderCache = new Map<string, GPUShaderModule>();
  private static pipelineCache = new Map<string, GPUComputePipeline>();

  static getShaderModule(device: GPUDevice, code: string): GPUShaderModule {
    const cached = this.shaderCache.get(code);
    if (cached) return cached;
    const module = device.createShaderModule({ code });
    this.shaderCache.set(code, module);
    return module;
  }

  static async getComputePipeline(device: GPUDevice, code: string): Promise<GPUComputePipeline> {
    const cached = this.pipelineCache.get(code);
    if (cached) return cached;
    const module = this.getShaderModule(device, code);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    });
    this.pipelineCache.set(code, pipeline);
    return pipeline;
  }

  static clear() {
    this.shaderCache.clear();
    this.pipelineCache.clear();
  }
}
