import { observable, makeObservable, action } from 'mobx';
import { IRDocument } from '../ir/types';
import { validateIR, ValidationError } from '../ir/validator';
import { CpuJitCompiler, CompiledJitResult } from '../webgpu/cpu-jit';
import { WgslGenerator } from '../webgpu/wgsl-generator';

export interface CompilationArtifacts {
  ir: IRDocument;
  compiled: CompiledJitResult;
  wgsl: Record<string, string>;
}

/**
 * REPL Manager - manages the lifecycle of an IRDocument.
 * Handles validation, compilation, and swapping.
 */
export class ReplManager {
  @observable
  public lastError: string | null = null;

  @observable
  public validationErrors: ValidationError[] = [];

  @observable
  public currentArtifacts: CompilationArtifacts | null = null;

  private cpuJit = new CpuJitCompiler();
  private wgslGen = new WgslGenerator();

  constructor() {
    makeObservable(this);
  }

  /**
   * Attempts to compile a new IRDocument.
   * If successful, it returns the artifacts (but DOES NOT swap them in automatically).
   */
  public async compile(ir: IRDocument): Promise<CompilationArtifacts | null> {
    this.setValidationErrors([]);
    this.setLastError(null);

    // 1. Validate
    const errors = validateIR(ir);
    if (errors.length > 0) {
      this.setValidationErrors(errors);
      this.setLastError('Validation failed');
      return null;
    }

    try {
      // 2. Compile CPU JIT
      const compiled = this.cpuJit.compile(ir, ir.entryPoint);

      // 3. Compile WGSL
      const wgsl: Record<string, string> = {};
      ir.functions.forEach(f => {
        if (f.type === 'shader') {
          wgsl[f.id] = this.wgslGen.compile(ir, f.id).code;
        }
      });

      return { ir, compiled, wgsl };
    } catch (e: any) {
      this.setLastError(`Compilation failed: ${e.message}`);
      console.error(e);
      return null;
    }
  }

  /**
   * Swaps in new artifacts as the active compiled state.
   */
  @action
  public swap(artifacts: CompilationArtifacts) {
    this.currentArtifacts = artifacts;
  }

  @action
  private setValidationErrors(errors: ValidationError[]) {
    this.validationErrors = errors;
  }

  @action
  private setLastError(error: string | null) {
    this.lastError = error;
  }
}
