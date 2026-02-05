/**
 * Standalone types for the host interface, decoupled from the IR.
 */
export type ScalarValue = number | boolean | string;
export type VectorValue = number[]; // Supports float2, float3, float4, float3x3, float4x4
export type MatrixValue = number[]; // Alias for clarity
export type ArrayValue = (number | boolean | string | number[] | Record<string, any>)[];

// Recursive structure for structs
export interface StructValue { [key: string]: RuntimeValue };
export type RuntimeValue = ScalarValue | VectorValue | MatrixValue | StructValue | ArrayValue;

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

export enum TextureFormat {
  Unknown = 'unknown',
  RGBA8 = 'rgba8',     // Standard 8-bit Normalized
  RGBA16F = 'rgba16f', // Half-Float
  RGBA32F = 'rgba32f', // Full-Float (High Precision)
  R8 = 'r8',           // Single Channel 8-bit
  R16F = 'r16f',       // Single Channel Half-Float
  R32F = 'r32f'        // Single Channel Full-Float
}

export interface ResourceDef {
  id: string;
  type: 'texture2d' | 'buffer' | 'atomic_counter';
  dataType?: string;
  format?: TextureFormat;
  sampler?: {
    wrap?: 'clamp' | 'repeat' | 'mirror';
    filter?: 'linear' | 'nearest';
  };
  // Persistence / Lifecycle
  persistence: {
    retain: boolean;         // If true, data persists across frames (History/Feedback).
    clearOnResize: boolean;  // Reset content if size changes?
    clearEveryFrame: boolean;// Explicitly clear at start of frame?
    clearValue?: any;        // Value to clear to (if clearing).
    cpuAccess: boolean;      // If true, enables Readback to Host (SLOW).
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

export interface PrecomputedShaderInfo {
  inputBinding?: number;
  inputLayout?: PrecomputedInputLayout;
  resourceBindings: { id: string, binding: number, type: 'texture2d' | 'buffer' }[];
}

export interface PrecomputedResourceInfo {
  type: 'texture2d' | 'buffer';
  componentCount: number;
  typedArray: 'Float32Array' | 'Int32Array' | 'Uint32Array' | 'Uint8Array';
  format?: string;
  isInteger?: boolean;
}

export interface PrecomputedInputLayout {
  totalSize: number;
  hasRuntimeArray: boolean;
  runtimeArray?: {
    name: string;
    offset: number;
    stride: number;
    elementType: string;
    elementOp: PrecomputedWriteOp;
  };
  ops: PrecomputedWriteOp[];
}

export type PrecomputedWriteOp =
  | { op: 'f32' | 'i32' | 'u32'; offset: number; path: string[] }
  | { op: 'vec'; offset: number; path: string[]; size: number; elementType: 'f32' | 'i32' | 'u32' }
  | { op: 'mat'; offset: number; path: string[]; dim: number }
  | { op: 'struct'; offset: number; path: string[]; members: PrecomputedWriteOp[] }
  | { op: 'array'; offset: number; path: string[]; length: number; stride: number; elementOp: PrecomputedWriteOp; elementType: string };

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

  /**
   * Initiates an asynchronous readback of a resource from GPU to CPU.
   */
  executeSyncToCpu(resId: string): void;

  /**
   * Waits for a previously initiated readback to complete.
   */
  executeWaitCpuSync(resId: string): Promise<void>;
}
