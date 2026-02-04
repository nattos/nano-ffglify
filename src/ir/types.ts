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
  globals?: any[]; // Globals for inter-node communication
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
  debug?: boolean; // Enable debug features (like variable syncing in JIT)
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

export type BuiltinName =
  | 'position'
  | 'vertex_index'
  | 'instance_index'
  | 'global_invocation_id'
  | 'local_invocation_id'
  | 'workgroup_id'
  | 'local_invocation_index'
  | 'num_workgroups'
  | 'frag_coord'
  | 'front_facing'
  | 'sample_index'
  | 'sample_mask'
  | 'subgroup_invocation_id'
  | 'subgroup_size';

export interface StructMember {
  name: string;
  type: DataType;
  comment?: string;
  // Annotation for flexible shader IO (e.g. '@builtin(position)')
  // If set to 'position', the generator treats this as the clip-space position.
  builtin?: BuiltinName;
  // Location index for inter-stage variables (auto-assigned if missing, but explicit is better)
  location?: number;
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
 *      These nodes have execution flow defined by properties like `exec_in`, `exec_out`, `exec_true`, `exec_false`, or `exec_body`.
 *    - **Pure Nodes**: Data operations (e.g. `math_*`, `vec_*`, `struct_*`, `var_get`).
 *      These nodes have NO side effects and produce values. They are evaluated primarily via "Pull" from Executable nodes.
 *
 * 2. **Entry Points**: Execution begins at "Entry Nodes". An Entry Node is any Executable Node that has NO incoming execution dependency (e.g. no `exec_in` pointing to it, or it's the start of the chain).
 *
 * 3. **Flow (Control Flow)**:
 *    - The executor maintains a queue of Executable Nodes.
 *    - Execution proceeds via properties defined in the node's schema:
 *      - `exec_in`: (Input) A reference to a node that must execute *before* this node.
 *      - `exec_out`: (Output) A reference to the node that executes *after* this node (standard sequence).
 *      - `exec_true` / `exec_false`: (Output) Branch destinations for `flow_branch`.
 *      - `exec_body` / `exec_completed`: (Output) Loop body and post-loop destinations for `flow_loop`.
 *    - Connectivity is reconstructed on-the-fly from these properties using schema metadata.
 *
 * 4. **Data Resolution (Data Flow)**:
 *    - Pure nodes are evaluated **lazily** and **synchronously** when an Executable Node (or another Pure node) references their ID in a property.
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

  metadata?: Record<string, any>;

  nodes: Node[];
}

export interface PortDef {
  id: string;
  type: DataType;
  comment?: string;
  // Shader IO
  builtin?: BuiltinName;
  location?: number;
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

// Note: In version 3.0+, Connectivity (Edges) is implicitly defined by Node properties.
// The Edge interface is kept for transient use within executors and visualization,
// but is no longer part of the serialized FunctionDef.
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
// The IR uses a strict set of Builtin Ops.
//
// Signatures Legend:
// - T: Generic Scalar (float) or Vector (floatN)
// - B: Boolean or Boolean Vector (implied)
//
// Most Math Ops support overloaded signatures:
// - Scalar: (float, float) -> float
// - Vector: (floatN, floatN) -> floatN
// - Broadcast: (floatN, float) -> floatN (and vice versa)
//
export type BuiltinOp =
  // ----------------------------------------------------------------
  // Math & Logic
  // ----------------------------------------------------------------
  // Standard Arithmetic:
  // Inputs: { a: T, b: T } | Output: T
  | 'math_add' | 'math_sub' | 'math_mul' | 'math_div' | 'math_mod'
  | 'math_pow' | 'math_min' | 'math_max'
  // Multiply-Add: { a: T, b: T, c: T } -> T (a * b + c)
  | 'math_mad'

  // Unary Math:
  // Inputs: { val: T } | Output: T
  | 'math_abs' | 'math_ceil' | 'math_floor' | 'math_sqrt' | 'math_exp' | 'math_log'
  | 'math_sin' | 'math_cos' | 'math_tan' | 'math_asin' | 'math_acos' | 'math_atan'
  | 'math_sinh' | 'math_cosh' | 'math_tanh' | 'math_asinh' | 'math_acosh' | 'math_atanh' | 'math_sign'
  | 'math_clamp' // { val: T, min: T, max: T } -> T
  | 'math_step' // { edge: T, x: T } -> T
  | 'math_smoothstep' // { edge0: T, edge1: T, x: T } -> T
  | 'math_mix' // { a: T, b: T, t: T|float } -> T

  // Special Math:
  | 'math_atan2' // { y: T, x: T } -> T
  | 'math_div_scalar' // { val: T(vec), scalar: float } -> T

  // Logic & Comparison:
  // Inputs: { a: T, b: T } | Output: T (0.0/1.0) or B (true/false)
  // Note: In strict mode, output is boolean. In shader mode, often maps to mix/step.
  | 'math_gt' | 'math_lt' | 'math_ge' | 'math_le' | 'math_eq' | 'math_neq'
  | 'math_and' | 'math_or' | 'math_xor' | 'math_not' // { val: B } -> B

  // Constants:
  | 'math_pi' | 'math_e' // { } -> float

  // ----------------------------------------------------------------
  // Advanced Math
  // ----------------------------------------------------------------
  // Unary: { val: T } -> T
  | 'math_fract' | 'math_trunc' | 'math_round'
  // Classification: { val: T } -> boolean
  | 'math_is_nan' | 'math_is_inf' | 'math_is_finite'
  // Advanced:
  | 'math_flush_subnormal' // { val: T } -> T
  // Decomposition:
  | 'math_mantissa' | 'math_exponent' // { val: T } -> T
  | 'math_frexp_mantissa' | 'math_frexp_exponent' // { val: T } -> T
  | 'math_ldexp' // { val: T, exp: int|T } -> T
  | 'literal' // { val: any } -> any

  // ----------------------------------------------------------------
  // Scalar Casts & Constructors
  // ----------------------------------------------------------------
  // Casts: { val: any } -> Type
  | 'static_cast_int' | 'static_cast_uint' | 'static_cast_float' | 'static_cast_bool'
  // Constructors: { val: scalar } -> scalar
  | 'float' | 'int' | 'uint' | 'bool' | 'string'

  // ----------------------------------------------------------------
  // Extended Types
  // ----------------------------------------------------------------
  // Vectors:
  | 'float2' // { x: float, y: float } -> float2
  | 'float3' // { x, y, z } -> float3
  | 'float4' // { x, y, z, w } -> float4
  | 'vec_length'    // { a: T } -> float
  | 'vec_normalize' // { a: T } -> T
  | 'vec_dot'       // { a: T, b: T } -> float
  | 'vec_mix'       // { a: T, b: T, t: float|T } -> T
  | 'color_mix'     // { a: float4, b: float4, t: float } -> float4 (Porter-Duff)
  | 'vec_swizzle'   // { vec: T, channels: string("xy") } -> T'
  | 'vec_get_element' // { vec: T, index: int } -> float

  // Matrices:
  | 'float3x3' // { ...9 floats }
  | 'float4x4' // { ...16 floats }
  | 'mat_identity'  // { size: int } -> mat
  | 'mat_mul'       // { a: mat, b: mat|vec } -> mat|vec
  | 'mat_transpose' // { val: mat } -> mat
  | 'mat_inverse'   // { val: mat } -> mat
  | 'mat_extract'   // { mat: mat, col: int, row: int } -> float

  // Quaternions:
  | 'quat' // { x, y, z, w }
  | 'quat_identity' // {} -> quat
  | 'quat_mul'      // { a: quat, b: quat } -> quat
  | 'quat_slerp'    // { a: quat, b: quat, t: float } -> quat
  | 'quat_to_float4x4' // { q: quat } -> float4x4
  | 'quat_rotate'   // { vec: float3, q: quat } -> float3

  // ----------------------------------------------------------------
  // Variables, Data, & Memory
  // ----------------------------------------------------------------
  | 'var_get'    // { var: string } -> any
  | 'var_set'    // { var: string, val: any } -> val
  | 'const_get'  // { name: string } -> any
  | 'const_data' // { val: any } -> any
  | 'builtin_get' // { name: BuiltinName } -> any
  | 'loop_index' // { loop: string } -> int

  // Structs:
  | 'struct_construct' // { ...members } -> struct (Type inferred from Op ID/Context)
  | 'struct_extract'   // { struct: T, field: string } -> T.field

  // Arrays:
  | 'array_construct'  // { ...elements } -> array
  | 'array_set'        // { array: string(Ref), index: int, val: T } -> void
  | 'array_extract'    // { array: T[], index: int } -> T
  | 'array_length'     // { array: T[] } -> int

  // ----------------------------------------------------------------
  // Flow Control
  // ----------------------------------------------------------------
  | 'flow_branch' // { cond: bool, true: NodeID, false: NodeID }
  | 'flow_loop'   // { count: int, body: NodeID }
  | 'call_func'   // { func: string, ...args } -> any
  | 'func_return' // { val: any }

  // ----------------------------------------------------------------
  // GPU / Resource Ops
  // ----------------------------------------------------------------
  // Buffers (Typed):
  | 'buffer_load'  // { buffer: string, index: int } -> T
  | 'buffer_store' // { buffer: string, index: int, value: T } -> void

  // Textures:
  | 'texture_sample' // { texture: string, uv: float2 } -> float4. NOTE: Emulated via manual bilinear/wrap logic in WGSL for universal compatibility with storage textures.
  | 'texture_load'   // { texture: string, coords: int2 } -> float4
  | 'texture_store'  // { texture: string, coords: int2, value: float4 } -> void

  // Metadata:
  | 'resource_get_size'   // { id: string } -> float2
  | 'resource_get_format' // { id: string } -> int

  // ----------------------------------------------------------------
  // Side Effects / Commands
  // ----------------------------------------------------------------
  | 'cmd_dispatch' // { func: string, dispatch: int3, ...args }
  | 'cmd_resize_resource' // { id: string, size: int2 }
  | 'cmd_draw'; // { target: string, vertex: string, fragment: string, count: int, pipeline: RenderPipelineDef }


// ------------------------------------------------------------------
// Render Pipeline Definitions
// ------------------------------------------------------------------
export interface RenderPipelineDef {
  topology?: 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip'; // Default: triangle-list
  cullMode?: 'none' | 'front' | 'back'; // Default: none
  frontFace?: 'ccw' | 'cw'; // Default: ccw
  depthStencil?: {
    format: TextureFormat;
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
