# GPU Marshalling Fixes

I have successfully resolved the GPU marshalling issues in the WebGPU backend, ensuring correct data transfer for complex types like matrices, structs, and arrays between the CPU and GPU.

## Accomplishments

### 1. Robust JIT Result Caching
Updated `CpuJitCompiler.ts` to ensure all node results are stored in stable local variables. Pure nodes (like `array_construct` and `struct_construct`) are now pre-evaluated or lazily cached, preventing redundant reconstructions and ensuring that side-effect modifications (like `array_set`) are correctly preserved and shared across the graph.

### 2. Standard-Compliant Data Packing (std430)
- **Matrices**: Fixed matrix type detection ([float3x3](file:///Users/nattos/Code/nano-ffglify/src/interpreter/ops.ts#385-386), [float4x4](file:///Users/nattos/Code/nano-ffglify/src/interpreter/ops.ts#384-385)) and implemented correct 16-byte column alignment and stride rules according to the `std430` layout.
- **Structs**: Improved struct alignment calculations and implemented case-insensitive struct ID lookups to handle inconsistent naming in the IR.
- **Arrays**: Fixed packing and alignment for fixed and runtime-sized arrays, including arrays of structs.

### 3. Execution & Readback Improvements
- **Result Truncation**: Implemented truncation of read-back buffer data to the expected resource width, resolving assertion failures caused by trailing zeros.
- **Error Propagation**: Removed error-swallowing `try-catch` blocks during shader initialization, allowing unsupported type errors (like strings) to be correctly caught and verified by tests.

## Verification Results

### Automated Tests
All 8 tests in [15-gpu-marshalling.test.ts](file:///Users/nattos/Code/nano-ffglify/src/tests/conformance/15-gpu-marshalling.test.ts) are now passing with 100% success.

```bash
TEST_BACKEND=WebGPU npx vitest run src/tests/conformance/15-gpu-marshalling.test.ts
```

| Test Category | Status | Details |
| :--- | :--- | :--- |
| **Scalars** | ✅ Passed | float, int, bool |
| **Vectors** | ✅ Passed | float2, float3, float4 |
| **Matrices** | ✅ Passed | float3x3, float4x4 |
| **Structs** | ✅ Passed | Nested members and alignment |
| **Fixed Arrays** | ✅ Passed | Alignment and padding |
| **Dynamic Arrays** | ✅ Passed | Runtime-sized arrays and `arrayLength` |
| **Struct Arrays** | ✅ Passed | Complex nesting and caching |
| **Errors: Strings** | ✅ Passed | Correct error propagation |

## Key Modifications

- [cpu-jit.ts](file:///Users/nattos/Code/nano-ffglify/src/webgpu/cpu-jit.ts): Stabilized result variables and pre-evaluation.
- [webgpu-executor.ts](file:///Users/nattos/Code/nano-ffglify/src/webgpu/webgpu-executor.ts): Fixed `std430` packing, struct lookup, and readback truncation.
- [host-ops.ts](file:///Users/nattos/Code/nano-ffglify/src/webgpu/host-ops.ts): Added missing host implementations for complex type operations.
- [wgsl-generator.ts](file:///Users/nattos/Code/nano-ffglify/src/webgpu/wgsl-generator.ts): Fixed matrix element access and index formatting.
