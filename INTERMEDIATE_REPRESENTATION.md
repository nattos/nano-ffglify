# Intermediate Representation (IR) Specification v3

## Overview
The IR is a JSON-serializable, graph-based format designed to abstract GPU compute and rendering pipelines. It treats logic as data, allowing for Agentic manipulation and visualization.

**Key Concepts:**
1.  **Unified Graph Execution**: Execution starts at a **Root CPU Function** (`entryPoint`).
2.  **Control Flow**: CPU and GPU graphs use "Execution Edges" to sequence side-effects (Dispatch, Store, Loop).
3.  **Strict Variable Types**: `localVars` only support POD types (scalars, vectors). **Resources (Textures, Buffers) cannot be stored in variables**; they are accessed via global IDs in Nodes.

## Structure

```typescript
interface IRDocument {
  version: string;        // "3.0.0"
  meta: MetaData;
  inputs: InputDef[];     // External Parameters (Uniforms)
  resources: ResourceDef[]; // Persistent State (Buffers, Textures)
  functions: FunctionDef[]; // Logic Blocks (CPU or GPU)
  entryPoint: string;     // ID of the root CPU function
  size: ResourceSize;

  // Persistence logic
  persistence: {
    retain: boolean; // True = keep data next frame (History)
    clearOnResize: boolean;
    clearEveryFrame: boolean;
    clearValue?: any;
    cpuAccess: boolean; // Need readback?
  };
}

type ResourceSize =
  | { mode: 'fixed', value: number | [number, number] }
  | { mode: 'viewport', scale?: number | [number, number] } // Relative to Output Resolution
  | { mode: 'reference', ref: string } // Match size of another resource/input (texture)
  | { mode: 'cpu_driven' }; // Explicitly sized via 'cmd_resize_resource' in CPU graph

```
### Resource Constraints
**Crucial**: WGSL 1.0 does not permit pointers/references to Resources (Textures/Buffers) as function arguments or local variables.
*   **Access**: Nodes OpCodes must reference resources by their `id` string (compile-time constant binding).
*   `op_get_texture_size`: CPU reads dimensions of an input/resource texture.
*   `cmd_resize_resource`: Resizes a 'cpu_driven' resource.

### Op Semantics & Quirks
1.  **Buffer Access**: `buffer_store/load` operations are **Typed**.
    *   The buffer element type is determined by the `ResourceDef` (e.g., `vec4<f32>`, `f32`).
    *   **No Implicit Flattening**: Storing a `vec4` writes the entire vector to a single index.
    *   `buffer[i] = vec4(...)`.
    *   Ensure your indexing logic aligns with the element count (e.g. index 0 is first vec4, index 1 is second vec4).
2.  **Color Mixing**: `color_mix` performs **Porter-Duff Source Over** alpha composition.
    *   Formula: `outA = srcA + dstA * (1 - srcA)`, `outRGB = (srcRGB*srcA + dstRGB*dstA*(1-srcA)) / outA`.
    *   **Quirk**: It explicitly handles `outA < 1e-5` to avoid NaN, returning `vec4(0)` (transparent black).
    *   Input/Output is non-premultiplied (Straight Alpha).

### Functions & Variables

```typescript
type FunctionType = 'cpu' | 'shader';

interface FunctionDef {
  id: string;
  type: FunctionType;
  inputs: PortDef[];  // Value inputs (float, float3, etc.) NO RESOURCES.
  outputs: PortDef[]; // Value outputs.

  localVars: VariableDef[];
  nodes: Node[];
  edges: Edge[];
}

interface VariableDef {
  id: string;
  type: 'float'|'int'|'bool'|'float2'|'float3'|'float4'|'float4x4'; // POD Only
  initialValue?: any;
}
```

---

## Example 1: "Two-Pass Blur" (Generate Kernel -> Apply)

**Concept**:
1.  **CPU**: Dispatch `fn_gen_kernel` (1 thread). Then Dispatch `fn_blur`.
2.  **`fn_gen_kernel`**: Computes Gaussian weights and stores them in `b_weights` buffer.
3.  **`fn_blur`**: Reads `b_weights` and `t_input` to produce result.

```json
{
  "version": "3.0",
  "meta": { "name": "Precomputed Blur" },
  "inputs": [
    { "id": "t_input", "type": "texture2d" },
    { "id": "u_kernel_size", "type": "int", "default": 16, "ui": { "min": 3, "max": 64 } }
  ],
  "resources": [
    { "id": "t_output", "type": "texture2d", "size": { "mode": "reference", "ref": "t_input" } },
    { "id": "b_weights", "type": "buffer", "dataType": "float", "size": { "mode": "cpu_driven" } }
  ],
  "entryPoint": "fn_main_cpu",

  "functions": [
    {
      "id": "fn_main_cpu",
      "type": "cpu",
      "nodes": [
        // 1. Resize Weights Buffer
        { "id": "resize_w", "op": "cmd_resize_resource", "resource": "b_weights", "size": "u_kernel_size" }, // 'u_kernel_size' input ref

        // 2. Dispatch Kernel Generation (Single thread)
        { "id": "cmd_gen", "op": "cmd_dispatch", "func": "fn_gen_kernel", "dispatch": [1, 1, 1] },
        // Edge: resize_w.exec_out -> cmd_gen.exec_in

        // 3. Dispatch Blur (Full screen)
        { "id": "get_size", "op": "resource_get_size", "resource": "t_input" },
        { "id": "calc_groups", "op": "math_div_scalar", "val": 8 },
        { "id": "cmd_blur", "op": "cmd_dispatch", "func": "fn_blur" }, // Inputs: calc_groups

        // Edge: cmd_gen.exec_out -> cmd_blur.exec_in (Enforces order!)
      ]
    },

    {
      "id": "fn_gen_kernel",
      "type": "shader",
      "localVars": [ { "id": "v_sum", "type": "float" } ],
      "nodes": [
        // Loop 0..16
        { "id": "loop", "op": "flow_loop", "start": 0, "end": 16 },

        // Calculate Gaussian (simplified)
        { "id": "idx", "op": "loop_index", "loop": "loop" },
        // ... Math ...
        { "id": "store", "op": "buffer_store", "buffer": "b_weights", "index": "idx" }
      ]
    },

    {
      "id": "fn_blur",
      "type": "shader",
      "localVars": [ { "id": "v_color", "type": "float4" } ],
      "nodes": [
        // Loop read b_weights
        { "id": "loop", "op": "flow_loop", "start": 0, "end": 16 },
        { "id": "w_val", "op": "buffer_load", "buffer": "b_weights", "index": "idx" },
        { "id": "tex_val", "op": "texture_sample", "tex": "t_input" }, // Offset logic omitted

        // Accumulate
        { "id": "prev", "op": "var_get", "var": "v_color" },
        { "id": "new", "op": "math_mad", "a": "tex_val", "b": "w_val", "c": "prev" }, // val*w + prev
        { "id": "set", "op": "var_set", "var": "v_color", "val": "new" }
      ]
    }
  ]
}
```

---

## Example 2: Recursive Function

**Note**: WebGPU (WGSL) does not natively support recursion. The compiler must either:
1.  Unroll constrained recursion.
2.  Emit an error if the target is WebGPU.
3.  Target Metal/HLSL only (which usually allow limited recursion).

```json
{
  "functions": [
    {
      "id": "fn_factorial",
      "type": "shader",
      "inputs": [ { "id": "n", "type": "int" } ],
      "outputs": [ { "id": "result", "type": "int" } ],
      "nodes": [
        // If n <= 1 return 1
        { "id": "check", "op": "math_lte", "a": "n", "b": 1 },
        { "id": "branch", "op": "flow_branch", "cond": "check" },

        // True Path: Return 1
        { "id": "ret_1", "op": "func_return", "val": 1 },

        // False Path: n * factorial(n-1)
        { "id": "n_sub", "op": "math_sub", "a": "n", "b": 1 },
        { "id": "recurse", "op": "call_func", "func": "fn_factorial", "args": ["n_sub"] },
        { "id": "mult", "op": "math_mul", "a": "n", "b": "recurse" },
        { "id": "ret_res", "op": "func_return", "val": "mult" }
      ]
    }
  ]
}
```
