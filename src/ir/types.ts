export type DataType =
  | 'float' | 'int' | 'bool'
  | 'vec2' | 'vec3' | 'vec4'
  | 'mat3' | 'mat4'
  | 'string' // logic only, usually
  | 'texture2d' // resource handle
  | 'sampler'
  | string; // Allow custom Struct IDs

// ------------------------------------------------------------------
// Core Document
// ------------------------------------------------------------------
export interface IRDocument {
  version: string;
  meta: MetaData;
  entryPoint: string; // ID of the root CPU function
  inputs: InputDef[];
  resources: ResourceDef[];
  structs: StructDef[]; // Shared struct type definitions
  functions: FunctionDef[];
}

export interface StructDef {
  id: string; // Type Name, e.g. "Particle"
  members: StructMember[];
}

export interface MetaData {
  name: string;
  author?: string;
  description?: string;
  license?: string;
}

// ------------------------------------------------------------------
// Inputs (Parameters / Uniforms)
// ------------------------------------------------------------------
export interface InputDef {
  id: string;
  type: DataType;
  label?: string;
  default?: any;
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

export enum TextureFormat {
  Unknown = 'unknown',
  RGBA8 = 'rgba8',
  RGBA16F = 'rgba16f',
  RGBA32F = 'rgba32f',
  R8 = 'r8',
  R16F = 'r16f',
  R32F = 'r32f'
}

export const TextureFormatValues: Record<TextureFormat, number> = {
  [TextureFormat.Unknown]: 0,
  [TextureFormat.RGBA8]: 1,
  [TextureFormat.RGBA16F]: 2,
  [TextureFormat.RGBA32F]: 3,
  [TextureFormat.R8]: 4,
  [TextureFormat.R16F]: 5,
  [TextureFormat.R32F]: 6
};

// Reverse mapping for looking up format string from integer
export const TextureFormatFromId: Record<number, TextureFormat> = Object.entries(TextureFormatValues).reduce((acc, [k, v]) => {
  acc[v] = k as TextureFormat;
  return acc;
}, {} as Record<number, TextureFormat>);

export interface ResourceDef {
  id: string;
  type: ResourceType;

  // For buffers
  dataType?: DataType;
  structType?: StructMember[]; // For custom layout buffers

  // For textures
  format?: TextureFormat; // Default 'rgba8'
  sampler?: {
    filter: 'nearest' | 'linear';
    wrap: 'clamp' | 'repeat' | 'mirror';
  };

  // Sizing
  size: ResourceSize;

  // Persistence / Lifecycle
  persistence: {
    retain: boolean;         // If true, functions as "History" (not cleared automatically)
    clearOnResize: boolean;
    clearEveryFrame: boolean;
    clearValue?: any;
    cpuAccess: boolean;      // If true, host can read back
  };
}

export interface StructMember {
  name: string;
  type: DataType;
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
}

export interface VariableDef {
  id: string;
  type: DataType; // Must be POD (scalar/vector/matrix)
  initialValue?: any;
}

// ------------------------------------------------------------------
// Nodes & Graph
// ------------------------------------------------------------------
export interface Node {
  id: string;
  op: string;
  // e.g. "math_add", "cmd_dispatch", "flow_branch", "var_set"

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

  // Vector & Color
  | 'vec2' | 'vec3' | 'vec4'
  | 'vec_length' | 'vec_normalize' | 'vec_dot' | 'vec_mix' | 'color_mix'
  | 'vec_swizzle' | 'vec_get_element'

  // Variables & Data
  | 'var_get' | 'var_set' | 'const_get' | 'loop_index'
  | 'struct_construct' | 'struct_extract'
  | 'array_construct' | 'array_extract' | 'array_set' | 'array_length'

  // Flow & Functions
  | 'flow_branch' | 'flow_loop' | 'call_func' | 'func_return'

  // Resources
  | 'buffer_load' | 'buffer_store'
  | 'texture_sample' | 'texture_store' | 'texture_load'
  | 'resource_get_size' | 'resource_get_format'

  // Commands (Side Effects)
  | 'cmd_dispatch' | 'cmd_resize_resource';

