export type DataType =
  | 'float' | 'int' | 'bool'
  | 'vec2' | 'vec3' | 'vec4'
  | 'mat3' | 'mat4'
  | 'color' // treating as vec4 in most backends
  | 'string' // logic only, usually
  | 'texture2d' // resource handle
  | 'sampler';

// ------------------------------------------------------------------
// Core Document
// ------------------------------------------------------------------
export interface IRDocument {
  version: string;
  meta: MetaData;
  entryPoint: string; // ID of the root CPU function
  inputs: InputDef[];
  resources: ResourceDef[];
  functions: FunctionDef[];
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

export interface ResourceDef {
  id: string;
  type: ResourceType;

  // For buffers
  dataType?: DataType;
  structType?: StructMember[]; // For custom layout buffers

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
// CPU:
// - "cmd_dispatch" (inputs: exec_in, dispatch_xyz, func)
// - "cmd_draw" (inputs: exec_in, vert_count, inst_count, func_vert, func_frag)
// - "cmd_resize_resource" (inputs: exec_in, resource, size)
// - "flow_branch", "flow_loop"
// - "resource_get_size"
//
// Shared/Shader:
// - "var_set", "var_get"
// - "math_add", "math_sub", ...
// - "texture_sample", "buffer_load", "buffer_store"
// - "call_func"
