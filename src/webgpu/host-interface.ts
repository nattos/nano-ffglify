import { RuntimeValue } from '../ir/resource-store';
import { RenderPipelineDef } from '../ir/types';

/**
 * Interface for the host environment provided to JIT-compiled CPU code.
 *
 * ARCHITECTURAL PRINCIPLE:
 * The compiled JS must NOT call back into this interface for any logic, math,
 * or data resolution. All math, vector operations, and struct management
 * must be inlined or handled via local helpers emitted in the JIT function.
 *
 * This ensures the JIT code behaves like a standalone "kernel", similar to WGSL.
 */
export interface RuntimeGlobals {
  /**
   * Dispatches a GPU compute shader.
   */
  dispatch(targetId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue>): Promise<void>;

  /**
   * Executes a GPU render pass.
   */
  draw(targetId: string, vertexId: string, fragmentId: string, vertexCount: number, pipeline: RenderPipelineDef): Promise<void>;

  /**
   * Resizes a resource (buffer or texture) in the execution context.
   */
  resize(resId: string, size: number | number[], format?: string | number, clear?: any): void;

  /**
   * Logs a message or action for debugging/profiling.
   */
  log(message: string, payload?: any): void;
}
