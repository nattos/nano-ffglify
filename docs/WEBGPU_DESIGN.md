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

### Texture Sampling & Sampler Emulation

While WebGPU provides native `sampler` and `textureSample` logic, it has strict constraints in **Compute Stages**, especially regarding **Unfilterable Float Formats** (e.g., `r32float`). To maintain parity with the CPU Interpreter and allow flexible sampling across all backends, we use a hybrid strategy:

1.  **Manual Emulation (Current/Compute)**:
    - The `WgslGenerator` implements manual **Bilinear Interpolation** and custom **Wrap Logic** (`repeat`, `mirror`, `clamp`) using `textureDimensions` and `textureLoad`.
    - This bypasses the need for a hardware `sampler` binding, allowing high-precision sampling on `r32float` and `rgba32float` textures which are normally restricted in WebGPU.
    - **Current implementation**: Logic is manually injected into `sample_<id>` helper functions in the generated WGSL.

2.  **Native Support (Future/Render)**:
    - In future Render stages (Fragment Shaders), hardware samplers will be used where possible for performance.
    - The `WgslOptions` preserve `samplerBindings` infrastructure in TypeScript (currently inactive) to support this transition.

3.  **Hardware Sampler Bypass**:
    - Hardware samplers are currently explicitly *not* allocated or bound in the `ForceOntoGPUTestBackend` to prevent validation errors on unfilterable formats.

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
The CPU portion of the IR (Control Flow, Logic) is executed by a specialized JIT Compiler (`CpuJitCompiler`). This compiler generates high-performance, **standalone** JavaScript code that emulates a low-level execution environment.

### Design Principles (Standalone & Portable)
1.  **Zero External Dependencies**: The *emitted* JS code does NOT rely on the `CpuJitCompiler` class, the `OpRegistry`, or any types from `src/ir`. This ensures the generated "kernel" is portable and can run in a browser or isolated worker.
2.  **Inlined Helpers**: All math, vector, and struct logic is emitted directly into the generated function as small "intrinsic" helpers (e.g., `_applyBinary`, `_vec_dot`, `_mat_mul`).
3.  **Decoupled Host Interface**: The JIT function accepts a simple `globals` object implementing the `RuntimeGlobals` interface. This interface uses standalone types (numbers, booleans, simple arrays/objects) rather than internal engine types.
4.  **Flat Scope**: Local variables are compiled to JS `let` variables in a flat scope, avoiding `Map` lookups for performance and WGSL parity.
5.  **Host Globals**:
    *   `dispatch(target, workgroups, args)`: Triggers a GPU compute shader.
    *   `draw(target, vertex, fragment, count, pipeline)`: Executes a GPU render pass.
    *   `resize(resId, size, format, clear)`: Manages resource dimensions and state.
    *   `log(msg, payload)`: Debugging and profiling.

### Compilation Strategy
*   **Reachable Function Analysis**: The JIT identifies all functions reachable from the entry point and emits them as nested `async` functions within the main kernel.
*   **Lazy Expression Emission**: Pure data nodes are emitted lazily at their first point of use, with internal dependency resolution to ensure correct order.
*   **Sanitization**: All IR identifiers (Node IDs, Variable IDs) are sanitized into valid JS identifiers to prevent conflicts and ensure characters like `@` or `.` in IDs are handled.

## Host Architecture
The `WebGpuHost` (in `src/webgpu/webgpu-host.ts`) provides a standalone implementation of the `RuntimeGlobals` interface.

1.  **Bridge Role**: It bridges the JIT-emitted code with the `WebGpuExecutor` and the `EvaluationContext`'s resource store.
    > [!NOTE]
    > These internal dependencies are temporary. The goal is to eventually remove all ties to the core engine's objects within the host implementation, making it strictly compliant with the standalone `RuntimeGlobals` interface.
2.  **Type Mapping**: It maps from the standalone host types back to the engine's internal types where necessary.
3.  **Resource Management**: Implements basic CPU-side logic for resource resizing and clearing, ensuring parity with the GPU state.

## Implementation Status (Updated 2026-02-02)

### 1. Standalone JIT Compiler (Implemented)
- **Status**: Complete.
- **Features**:
  - Independent JS emission (zero IR dependencies).
  - High-performance flat scope for variables.
  - Comprehensive list of inlined math/vector/quaternion helpers.
  - Cycle detection to prevent infinite recursion in IR calls.

### 2. Standalone Host Interface (Implemented)
- **Status**: Complete.
- **Components**:
  - `RuntimeGlobals` interface & standalone types.
  - `WebGpuHost` bridge implementation.
  - All texture sampling, load/store, and resource metadata operations supported.

### 3. WebGPU Executor (Implemented)
- **Status**: Functional. Supports both direct shader dispatch and hybrid CPU-JIT execution.
- **Capability**: 100% Pass rate on all core and integration conformance tests.

## Next Steps

1.  **Render Pipeline Depth**: Full implementation of `cmd_draw` and complex `RenderPipelineDef` options in the JIT.
2.  **JS Emission Cleanup**: Refine the code generator to produce even cleaner, more minifiable JS code.
3.  **Advanced features**: Atomic operations and workgroup shared memory support in both WGSL and JIT.
