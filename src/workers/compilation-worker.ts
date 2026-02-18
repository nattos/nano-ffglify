/**
 * Compilation Worker - validate IR, JIT compile, WGSL generate.
 * Stateless: each compile is independent.
 */
import { validateIR } from '../ir/validator';
import { CpuJitCompiler } from '../webgpu/cpu-jit';
import { WgslGenerator } from '../webgpu/wgsl-generator';
import type { CompilationWorkerRequest, CompilationWorkerResponse, SerializedArtifacts } from './protocol';

const cpuJit = new CpuJitCompiler();
const wgslGen = new WgslGenerator();

self.onmessage = (e: MessageEvent<CompilationWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'compile') {
    handleCompile(msg.id, msg.ir);
  }
};

async function handleCompile(id: number, ir: import('../ir/types').IRDocument) {
  // 1. Validate
  const errors = validateIR(ir);
  if (errors.length > 0) {
    const response: CompilationWorkerResponse = {
      type: 'compile-error',
      id,
      errors,
      message: 'Validation failed',
    };
    self.postMessage(response);
    return;
  }

  try {
    // 2. Compile CPU JIT
    const compiled = cpuJit.compile(ir, ir.entryPoint);

    // 3. Compile WGSL for all shader functions
    const wgsl: Record<string, string> = {};
    ir.functions.forEach(f => {
      if (f.type === 'shader') {
        wgsl[f.id] = wgslGen.compile(ir, f.id).code;
      }
    });

    // 4. Post result with code strings (not functions)
    const artifacts: SerializedArtifacts = {
      ir,
      finalInitCode: compiled.finalInitCode,
      finalTaskCode: compiled.finalTaskCode,
      initCode: compiled.initCode,
      taskCode: compiled.taskCode,
      wgsl,
    };

    const response: CompilationWorkerResponse = {
      type: 'compiled',
      id,
      artifacts,
    };
    self.postMessage(response);
  } catch (e: any) {
    const response: CompilationWorkerResponse = {
      type: 'compile-error',
      id,
      errors: [],
      message: `Compilation failed: ${e.message}`,
    };
    self.postMessage(response);
  }
}
