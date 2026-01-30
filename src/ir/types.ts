export type DataType =
  | 'float' | 'int' | 'bool'
  | 'float2' | 'float3' | 'float4'
  | 'float3x3' | 'float4x4'
  | 'string' // logic only, usually
  | 'texture2d' // resource handle
  | 'sampler'
  | string; // Allow custom Struct IDs or "array<T, N>" syntax (e.g. "array<f32, 10>")

export const PRIMITIVE_TYPES = [
  'float', 'int', 'bool',
  'float2', 'float3', 'float4',
  'float3x3', 'float4x4',
  'string',
  'texture2d',
  'sampler'
] as const;

// ------------------------------------------------------------------
// Core Document
// ------------------------------------------------------------------
export interface IRDocument {
  version: string;
  meta: Metadata;
  entryPoint: string; // ID of the root CPU function
  inputs: InputDef[];
  resources: ResourceDef[];
  structs: StructDef[]; // Shared struct type definitions
  functions: FunctionDef[];
  comment?: string;
}

export interface StructDef {
  id: string; // Type Name, e.g. "Particle"
  members: StructMember[];
  comment?: string;
}

export interface Metadata {
  name: string;
  author?: string;
  description?: string;
  license?: string;
}

// ------------------------------------------------------------------
// Inputs (Parameters / Uniforms)
// ------------------------------------------------------------------
// InputDef defines a Graph Input (Uniform).
// These are values exposed to the host environment (UI) and passed to the graph.
export interface InputDef {
  id: string;        // Unique identifier (variable name)
  type: DataType;    // Data type (float, int, float3, etc.)
  label?: string;    // Human-readable label for UI
  comment?: string;  // Description
  format?: string;   // For textures: 'rgba8', 'rgba32f', etc. hints for UI/Validation
  default?: any;     // Default value if not provided by host
  ui?: {
    min?: number;
    max?: number;
    widget?: 'slider' | 'color_picker' | 'text' | 'toggle' | 'file';
  };
}

// ------------------------------------------------------------------
// Resources (Buffers / Textures / State)
// ------------------------------------------------------------------
export type ResourceSize =
  | { mode: 'fixed'; value: number | [number, number] }
  | { mode: 'viewport'; scale?: number | [number, number] }
  | { mode: 'reference'; ref: string }
  | { mode: 'cpu_driven' }; // Explicitly sized by CPU command, e.g. cmd_resize_resource

export type ResourceType = 'texture2d' | 'buffer' | 'atomic_counter';

// TextureFormat: Explicit Integer Enum for efficient Runtime processing.
// Uses explicit string values ('rgba8' etc) for serialization compatibility/readability.
export enum TextureFormat {
  Unknown = 'unknown',
  RGBA8 = 'rgba8',     // Standard 8-bit Normalized
  RGBA16F = 'rgba16f', // Half-Float
  RGBA32F = 'rgba32f', // Full-Float (High Precision)
  R8 = 'r8',           // Single Channel 8-bit
  R16F = 'r16f',       // Single Channel Half-Float
  R32F = 'r32f'        // Single Channel Full-Float
}

// Runtime Integer Map for fast switch/lookup in C++/ASM execution.
export const TextureFormatValues: Record<TextureFormat, number> = {
  [TextureFormat.Unknown]: 0,
  [TextureFormat.RGBA8]: 1,
  [TextureFormat.RGBA16F]: 2,
  [TextureFormat.RGBA32F]: 3,
  [TextureFormat.R8]: 4,
  [TextureFormat.R16F]: 5,
  [TextureFormat.R32F]: 6
};

// Reverse mapping for looking up format string from integer ID.
export const TextureFormatFromId: Record<number, TextureFormat> = Object.entries(TextureFormatValues).reduce((acc, [k, v]) => {
  acc[v] = k as TextureFormat;
  return acc;
}, {} as Record<number, TextureFormat>);

export interface ResourceDef {
  id: string;
  type: ResourceType;
  comment?: string;

  // For buffers: The native type of elements stored (e.g. 'float', 'int')
  dataType?: DataType;
  structType?: StructMember[]; // For custom layout buffers

  // For textures: The pixel format.
  // Must match a recognized TextureFormat enum value.
  format?: TextureFormat; // Default 'rgba8'

  // Sampling parameters (if applicable)
  sampler?: {
    filter: 'nearest' | 'linear';
    wrap: 'clamp' | 'repeat' | 'mirror';
  };

  // Sizing Strategy
  size: ResourceSize;

  // Persistence / Lifecycle
  persistence: {
    retain: boolean;         // If true, data persists across frames (History/Feedback).
    clearOnResize: boolean;  // Reset content if size changes?
    clearEveryFrame: boolean;// Explicitly clear at start of frame?
    clearValue?: any;        // Value to clear to (if clearing).
    cpuAccess: boolean;      // If true, enables Readback to Host (SLOW).
  };
}

export interface StructMember {
  name: string;
  type: DataType;
  comment?: string;
}

// ------------------------------------------------------------------
// Functions & Logic
// ------------------------------------------------------------------
export type FunctionType = 'cpu' | 'shader';

/**
 * Function Definition
 *
 * Execution Semantics:
 * 1. **Nodes Categories**:
 *    - **Executable Nodes**: Side-effect operations (e.g. `cmd_*`, `flow_*`, `*_store`, `call_func`, `var_set`, `array_set`).
 *      These nodes MUST be triggered by an 'execution' edge (or be an Entry Node).
 *    - **Pure Nodes**: Data operations (e.g. `math_*`, `vec_*`, `struct_*`, `var_get`).
 *      These nodes have NO side effects and produce values. They are evaluated primarily via "Pull" from Executable nodes.
 *
 * 2. **Entry Points**: Execution begins at "Entry Nodes". An Entry Node is any Executable Node that has NO incoming 'execution' type edges.
 *
 * 3. **Flow (Control Flow)**:
 *    - The executor maintains a queue of Executable Nodes.
 *    - Execution proceeds via 'execution' edges from completed Executable Nodes.
 *    - Order is strictly determined by these edges.
 *
 * 4. **Data Resolution (Data Flow)**:
 *    - Pure nodes are evaluated **lazily** and **synchronously** when an Executable Node demands their value.
 *    - **State Access**: `var_get` reads the variable's value *at the moment of evaluation*.
 *    - This means if `Executable A` mutates `Var X`, and `Executable B` (which runs after A) consumes `var_get(X)`, B sees the new value.
 *
 * 5. **Recursion**: Recursive function calls (direct or indirect) are **FORBIDDEN** and must cause a runtime error.
 */
export interface FunctionDef {
  id: string;
  type: FunctionType;
  comment?: string;

  // Arguments & Return values
  // NOTE: For 'shader' functions, these are mostly for internal calls or stage-io.
  // Resources are NOT passed here, they are global.
  inputs: PortDef[];
  outputs: PortDef[];

  // Local Mutable Variables (POD only)
  localVars: VariableDef[];

  nodes: Node[];
  edges: Edge[];
}

export interface PortDef {
  id: string;
  type: DataType;
  comment?: string;
}

export interface VariableDef {
  id: string;
  type: DataType; // Must be POD (scalar/vector/matrix) or array<T, N>
  // Initial value for the variable.
  // If undefined, code generators will construct a standard default value (e.g. 0, false, empty primitives).
  initialValue?: any;
  comment?: string;
}

// ------------------------------------------------------------------
// Nodes & Graph
// ------------------------------------------------------------------
export interface Node {
  id: string;
  op: string;
  // e.g. "math_add", "cmd_dispatch", "flow_branch", "var_set"
  comment?: string;

  // Static configuration/literals (not inputs)
  const_data?: any;

  // Debug/Viz info
  metadata?: {
    x: number;
    y: number;
    label?: string;
  };

  // Op-specific arguments (flattened for JSON simplicity)
  [key: string]: any;
}

export type EdgeType = 'data' | 'execution';

export interface Edge {
  from: string;    // Node ID
  portOut: string; // "exec_out", "val", "x", etc.
  to: string;      // Node ID
  portIn: string;  // "exec_in", "a", "b", etc.
  type: EdgeType;
  comment?: string;
}

// ------------------------------------------------------------------
// Standard OpCodes (Reference)
// ------------------------------------------------------------------
export type BuiltinOp =
  // Math & Logic
  | 'math_add' | 'math_sub' | 'math_mul' | 'math_div' | 'math_mad'
  | 'math_mod' | 'math_clamp' | 'math_abs' | 'math_ceil' | 'math_floor'
  | 'math_min' | 'math_max' | 'math_pow' | 'math_sqrt' | 'math_exp' | 'math_log'
  | 'math_sin' | 'math_cos' | 'math_tan' | 'math_asin' | 'math_acos' | 'math_atan' | 'math_atan2'
  | 'math_sinh' | 'math_cosh' | 'math_tanh' | 'math_sign'
  | 'math_div_scalar'
  | 'math_gt' | 'math_lt' | 'math_ge' | 'math_le' | 'math_eq' | 'math_neq'
  | 'math_and' | 'math_or' | 'math_xor' | 'math_not'
  | 'math_pi' | 'math_e'

  // Advanced Math
  | 'math_fract' | 'math_trunc'
  | 'math_is_nan' | 'math_is_inf' | 'math_is_finite'
  | 'math_flush_subnormal'
  | 'math_mantissa' | 'math_exponent'

  // Scalar Casts
  | 'static_cast_int' | 'static_cast_float' | 'static_cast_bool'
  // Scalar Constructors
  | 'float' | 'int' | 'bool' | 'string'

  // Vector & Color
  | 'float2' | 'float3' | 'float4'
  | 'vec_length' | 'vec_normalize' | 'vec_dot' | 'vec_mix'
  // Performs Porter-Duff "Source Over" alpha composition.
  // Note: Handles zero-alpha without NaN (returns 0).
  | 'color_mix'
  | 'vec_swizzle' | 'vec_get_element'

  // Matrix
  | 'float3x3' | 'float4x4'
  | 'mat_identity' | 'mat_mul' | 'mat_transpose' | 'mat_inverse'

  // Quaternion
  | 'quat' | 'quat_identity' | 'quat_mul' | 'quat_slerp' | 'quat_to_float4x4' | 'quat_rotate'

  // Variables & Data
  | 'var_get' | 'var_set' | 'const_get' | 'loop_index'
  // struct_construct: 'type' MUST match a defined StructDef.id. Inputs match member names.
  | 'struct_construct' | 'struct_extract'
  // array_construct: 'fill' value determines element type if not inferred.
  // array_set: 'array' input MUST resolve to a generic Variable L-Value (var_get or similar).
  // It cannot be a direct expression result.
  | 'array_construct' | 'array_extract' | 'array_set' | 'array_length'

  // Flow & Functions
  // call_func: Execution node that also produces a value (if outputs > 0).
  // The generator captures this return value in a temporary variable for downstream data use.
  | 'flow_branch' | 'flow_loop' | 'call_func' | 'func_return'

  // Resources
  // buffer_store/load accesses are typed based on the resource definition.
  // No implicit flattening occurs. The type of the value being written must match the type of the buffer.
  // Validation enforces strict type matching (e.g. storing float into int buffer is an error).
  | 'buffer_load' | 'buffer_store'
  | 'texture_sample' | 'texture_store' | 'texture_load'
  | 'resource_get_size' | 'resource_get_format'

  // Commands (Side Effects)
  | 'cmd_dispatch' | 'cmd_resize_resource';

