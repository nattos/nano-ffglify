import { RuntimeValue, ResourceState } from '../ir/resource-store';
import { BuiltinOp, RenderPipelineDef } from '../ir/types';

/**
 * Interface for the host environment provided to JIT-compiled CPU code.
 */
export interface RuntimeGlobals {
  /**
   * Invokes a built-in operation (e.g., math, vector, matrix).
   */
  callOp(op: BuiltinOp, args: Record<string, any>): RuntimeValue;

  /**
   * Dispatches a GPU compute shader.
   */
  dispatch(targetId: string, workgroups: [number, number, number], args: Record<string, RuntimeValue>): Promise<void>;

  /**
   * Executes a GPU render pass.
   */
  draw(targetId: string, vertexId: string, fragmentId: string, vertexCount: number, pipeline: RenderPipelineDef): Promise<void>;

  /**
   * Resizes a resource (buffer or texture).
   */
  resize(resId: string, size: number | number[], format?: string | number, clear?: any): void;

  /**
   * Logs a message or action for debugging.
   */
  log(message: string, payload?: any): void;

  /**
   * Resolves a string that could be an input name or a literal.
   */
  resolveString(val: string): RuntimeValue;

  /**
   * Resolves a variable that could be a builtin or global input.
   */
  resolveVar(id: string): RuntimeValue;
}
