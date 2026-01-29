
import { IRDocument } from '../../ir/types';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { TestBackend } from './test-runner';
import { WebGpuBackend } from './webgpu-backend';

/**
 * ComputeTestBackend
 *
 * A specialized backend that forces the Execution Graph (which is usually CPU logic in conformance tests)
 * to run as a Compute Shader on the GPU.
 *
 * Strategy:
 * 1. Analyze the Entry Point Function.
 * 2. Identify all 'var_set' and 'var_get' operations on globals.
 * 3. Allocate a 'Global Storage Buffer' to hold these values.
 * 4. Generate WGSL that treats 'fn_main' as a compute kernel, mapping global vars to storage buffer offsets.
 * 5. Dispatch (1, 1, 1).
 * 6. Read back the storage buffer and populate the EvaluationContext variables.
 */
export const ComputeTestBackend: TestBackend = {
  name: 'Compute',

  createContext: async (ir: IRDocument, inputs?: Map<string, RuntimeValue>) => {
    // Reuse WebGpuBackend's context creation (device init, resource alloc)
    return WebGpuBackend.createContext(ir, inputs);
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    // This run method is invalid for this backend since 'execute' handles the full flow
    // including buffer readback which 'run' signature doesn't easily support without side effects.
    // However, execute calls run usually.
    // We will override execute mostly.
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    // 1. Setup Context
    const ctx = await ComputeTestBackend.createContext(ir, inputs);
    const backend = WebGpuBackend; // Access static/singleton if available, or just leverage what we have.

    // We need internal access to WebGpuExecutor.
    // WebGpuBackend.execute does: run(ctx, entry).

    // Custom Execution Logic
    // We need to synthesize a "Test Kernel" wrapper in WGSL.

    // Stub implementation for now to verify integration
    throw new Error('ComputeTestBackend: WGSL Generation not implemented yet.');

    return ctx;
  }
};
