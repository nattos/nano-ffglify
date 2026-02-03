export class GpuCache {
  private static shaderCache = new Map<string, GPUShaderModule>();
  private static pipelineCache = new Map<string, GPUComputePipeline>();

  static async getShaderModule(device: GPUDevice, code: string): Promise<GPUShaderModule> {
    const cached = this.shaderCache.get(code);
    if (cached) return cached;
    const module = device.createShaderModule({ code });

    const info = await module.getCompilationInfo();
    if (info.messages.length > 0) {
      let hasError = false;
      const formatted = info.messages.map(m => {
        if (m.type === 'error') hasError = true;
        return `[${m.type.toUpperCase()}] line ${m.lineNum}:${m.linePos} - ${m.message}`;
      }).join('\n');

      if (hasError) {
        console.error(`[Shader Compilation Error]\n${formatted}`);
        // Log formatted code with line numbers for debugging
        const lines = code.split('\n');
        const codeView = lines.map((l, i) => `${(i + 1).toString().padStart(4, ' ')}| ${l}`).join('\n');
        console.error(`[Source Code]\n${codeView}`);
      } else {
        console.warn(`[Shader Compilation Warning]\n${formatted}`);
      }
    }

    this.shaderCache.set(code, module);
    return module;
  }

  static async getComputePipeline(device: GPUDevice, code: string): Promise<GPUComputePipeline> {
    const cached = this.pipelineCache.get(code);
    if (cached) return cached;
    const module = await this.getShaderModule(device, code);
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
