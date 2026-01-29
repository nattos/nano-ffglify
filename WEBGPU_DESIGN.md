# WebGPU Backend Design

## Goal
Execute the Nano-FFGLify Intermediate Representation (IR) on the GPU using WebGPU (via `webgpu` package in Node.js or browser). This will enable high-performance parallel execution of shaders and compute kernels defined in the IR.

## Architecture

The `WebGpuBackend` will implement the `TestBackend` interface, allowing it to be a drop-in replacement for `InterpreterBackend` in conformance tests.

### Components

1.  **WebGpuBackend**:
    -   Manages the `GPUDevice` and `GPUAdapter`.
    -   Handles Context creation (`createContext`).
    -   Orchestrates execution (`run`).
    -   Synchronizes results back to CPU for verification (in strict testing mode).

2.  **WebGpuExecutor**:
    -   Responsible for translating a specific Function or Graph into a GPU pipeline.
    -   **JIT Compilation**: Converts IR Functions -> WGSL Shader Module.
    -   **Resource Binding**: Maps `EvaluationContext` resources (Buffers, Textures) to `GPUBindGroup` entries.
    -   **Command Encoding**: Records `ComputePass` (and future `RenderPass`) commands.

3.  **WGSL Generator**:
    -   A transpiler that converts IR Nodes into valid WGSL code for GPU Execution.

4.  **JS/ASM Compiler** (CPU Host):
    -   A transpiler that converts IR Nodes into "ASM.js-like" flat JavaScript.
    -   Avoids object allocation, closures, and GC during execution.
    -   Mimics machine code structure (flat memory/stack interaction) to serve as a blueprint for future C++ backends.


## Execution Flow

1.  **Setup**:
    -   `WebGpuBackend.createContext(ir)`:
        -   Initializes `GPUDevice`.
        -   Allocates `GPUBuffer` and `GPUTexture` for all resources in `ir.resources` and `ir.inputs`.
        -   Uploads initial data (if any).

2.  **Run**:
    -   `WebGpuBackend.run(ctx, entryPoint)`:
        -   Identifies the target function.
        -   **Generate WGSL**: Transpiles the function and its dependencies to WGSL.
            -   *Optimization*: Cache Shader Modules by function ID/hash.
        -   **Create Pipeline**: `device.createComputePipeline(...)`.
        -   **Create BindGroup**: specific to the current resource state.
        -   **Dispatch**:
            -   For `type: 'shader'` (Compute): Dispatch based on grid size.
            -   For `type: 'cpu'` (Control Flow):
                -   **Strategy**: Instead of interpreting, we will compile this to **ASM.js-like JavaScript**.
                -   **JS Compiler**: A second compiler that generates low-level, flat JS code (no closures, no garbage collection, direct TypedArray access) to execute the CPU portion of the graph.
                -   This ensures high performance and portability (blueprint for C++ loop).
                -   The compiled CPU code will invoke `WebGpuExecutor` methods for GPU dispatches (`cmd_dispatch`, `cmd_draw`).
3.  **Readback (Verification)**:
    -   After execution, copying results from `STORAGE` buffers to `MAP_READ` buffers.
    -   Mapping and reading into `EvaluationContext` resources for assertions.

## WGSL Generation Strategy

We need to map IR definitions to WGSL.

### Header
```wgsl
diagnostic(off, derivative_uniformity); // As requested

struct Particle {
  pos: vec2<f32>,
  vel: vec2<f32>,
}
```

### Bindings
Resources are bound globally or per-group.
```wgsl
@group(0) @binding(0) var<storage, read_write> b_result : array<f32>;
@group(0) @binding(1) var t_input : texture_2d<f32>;
```

### Function Body
Map IR Nodes to variable declarations and statements in topological order.

```wgsl
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) GlobalInvocationID : vec3<u32>) {
  // node: id=in, op=var_get
  let in_val = b_result[GlobalInvocationID.x];

  // node: id=op, op=math_add
  let op_val = in_val + 10.0;

  // node: id=store
  b_result[GlobalInvocationID.x] = op_val;
}
```

## Anticipated Issues & mitigations

### 1. Uniformity Analysis
**Issue**: WGSL is strict about control flow depending on non-uniform values.
**Mitigation**: `diagnostic(off, derivative_uniformity);`.

### 2. Struct Layout (std140 vs std430)
**Issue**: `storage` buffers use `std430`, `uniform` buffers use `std140`. CPU interpreter uses tight packing.
**Mitigation**:
-   Design IR structs to respect `std430` alignment (e.g., `vec3` takes 16 bytes).
-   Or implement padding logic in the interpreter/validator to match GPU layout.

### 3. Infinite Loops (TDR)
**Mitigation**: Ensure termination in tests.

### 4. Arrays of Arrays / Pointers
**Mitigation**: Use flattened arrays or specific Texture types.

### 5. `vec3` Handling
**Issue**: `vec3` padding.
**Mitigation**: Prefer `vec4`.

### 6. Dynamic Indexing & OOB
**Issue**: GPU Clamps/Zeroes on OOB, CPU Throws.
**Mitigation**: Recognize that `03-buffers.test.ts` (Runtime Error) behaviors differ. GPU tests should expect safe default behavior (0), not crashes.

## CPU-JIT Compiler Design (Host Executor)
The CPU portion of the IR (Control Flow, Logic) is executed by a specialized JIT Compiler (`CpuJitCompiler`) rather than an interpreter. This compiler generates high-performance, flat JavaScript code that emulates an ASM.js / low-level execution environment.

### Design Principles
1.  **Sync Execution**: The generated JS code runs synchronously, treating GPU dispatches as immediate calls (or queued commands) depending on the desired behavior.
2.  **Flat Memory Model**: It tries to avoid complex object allocations. Local variables are compiled to JS `let` or `const` in a flat scope.
3.  **Global Bindings**: The JIT function accepts a `globals` object which provides the interface to the environment:
    *   `callOp(name, args)`: Invokes the `OpRegistry` for complex operations (vectors, math).
    *   `dispatch(target, dim)`: Invokes the GPU dispatch logic.
    *   `bufferLoad/Store`: Direct access to resource data.
    *   `resize`: Resource management.
4.  **Vector Support via Registry**: While scalar math is inlined for performance (`a + b`), vector operations delegate to `globals.callOp` to leverage the centralized `OpRegistry` logic (handling arrays, broadcasting, mixed-types).
5.  **Polyfills**:
    *   `GlobalInvocationID`: In fallback mode (shader on CPU), this is injected into the scope as a loop variable.

### Compilation Strategy
*   **Topological Walk**: execution nodes are visited in flow order (Branch/Loop/Seq).
*   **Data Resolution**: Data inputs (`data` edges) are compiled recursively into expressions (e.g., `globals.bufferLoad(..., i + 1)`).
*   **Statement Emission**: Executable nodes (`var_set`, `cmd_dispatch`) emit specific JS statements.

## Next Steps

1.  **Skeleton**: Implement `WebGpuExecutor` structure.
2.  **Transpiler**: Build `irToWgsl(functionDef)`.
3.  **Integration**: Hook into `TestRunner`.
