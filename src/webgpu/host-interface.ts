/**
 * Standalone types for the host interface, decoupled from the IR.
 */
export type RuntimeValue =
  | number
  | boolean
  | string
  | number[]
  | { [key: string]: RuntimeValue }
  | RuntimeValue[];

export interface RenderPipelineDef {
  topology?: 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';
  cullMode?: 'none' | 'front' | 'back';
  frontFace?: 'ccw' | 'cw';
  depthStencil?: {
    format: string; // Decoupled from TextureFormat enum
    depthWriteEnabled: boolean;
    depthCompare: 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';
  };
  blend?: {
    color: BlendComponent;
    alpha: BlendComponent;
  };
}

export interface BlendComponent {
  operation?: 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
  srcFactor?: BlendFactor;
  dstFactor?: BlendFactor;
}

export type BlendFactor =
  | 'zero' | 'one'
  | 'src' | 'one-minus-src' | 'src-alpha' | 'one-minus-src-alpha'
  | 'dst' | 'one-minus-dst' | 'dst-alpha' | 'one-minus-dst-alpha';

export interface ResourceDef {
  id: string;
  type: 'texture2d' | 'buffer' | 'atomic_counter';
  dataType?: string;
  format?: string;
  sampler?: {
    wrap?: 'clamp' | 'repeat' | 'mirror';
    filter?: 'linear' | 'nearest';
  };
}

export interface ResourceState {
  def: ResourceDef;
  data?: any; // The raw data depending on type
  width: number;
  height: number;
  /**
   * The underlying WebGPU buffer handle, if allocated.
   * This is managed by the runtime (e.g. intrinsics.js or WebGpuExecutor).
   */
  gpuBuffer?: GPUBuffer;

  /**
   * The underlying WebGPU texture handle, if allocated.
   * This is managed by the runtime.
   */
  gpuTexture?: GPUTexture;
}

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
