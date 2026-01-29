# IR Engine Edge Cases & Failure Modes

A comprehensive list of potential edge cases to test for compliance, robustness, and stability across CPU and GPU environments.

## 1. Type System & Static Structure
*Compiler/Validation Level*

### Dimensionality
### 9. Swizzling
- [STATIC CHECKED] `float2.z` (accessing component out of bounds) -> **Static Error** `Swizzle component 'z' out of bounds for float2`
- [STATIC CHECKED] `float4.xyzwq` (too many components) -> **Static Error** `Invalid swizzle mask length`
- [STATIC CHECKED] `float3.x` (scalar output type inference) -> Works (returns `number`), downstream type check catches if used incorrectly.
- [STATIC CHECKED] `float2.xy` (vector output) -> Works (returns `float2`).

### 10. Constructors
- [STATIC CHECKED] `float2(1)` (missing arg) -> **Static Error** `Missing required argument 'y'`
- [STATIC CHECKED] `float2(1, 2, 3)` (extra arg) -> **Static Error** `Unknown argument(s) 'z'`

### 11. Structs
- [STATIC CHECKED] Recursive struct (A contains B, B contains A) -> **Static Error** `Recursive struct definition detected`
- [STATIC CHECKED] `struct_extract` on non-struct type -> **Static Error** `Type Mismatch`
- **What if...** a matrix constructor (`float4x4`) is provided with too few or too many arguments?
- **What if...** we access a matrix column index that is out of bounds (e.g., `col[4]` on `float4x4`)?
- [STATIC CHECKED] **What if...** we attempt math operations on incompatible types (Scalar vs Vector)? (Verified in `09-errors.test.ts`)
- [STATIC CHECKED] **What if...** we use `vec_dot` on vectors of mismatched lengths? (Verified in `09-errors.test.ts`)
- [STATIC CHECKED] **What if...** we use `mat_mul` on mismatched dimensions (float4x4 x float3)? (Verified in `09-errors.test.ts`)

### Structs & Composition
- [STATIC CHECKED] Recursive struct definition -> **Static Error** `Recursive struct definition detected`
- [STATIC CHECKED] Duplicate Struct IDs -> **Static Error** `Duplicate Struct ID '...'`
- [STATIC CHECKED] **What if...** we use `struct_extract` on a key that doesn't exist (or on a non-struct)? (Verified in `09-errors.test.ts`)
- [STATIC CHECKED] **What if...** we `struct_construct` with missing fields? -> **Static Error** `Missing required field`

### Functions & Signals
- [STATIC CHECKED] **What if...** a node input arg is missing (e.g. `math_add` missing `b`)? (Verified in `09-errors.test.ts` - Undefined behavior)
- [STATIC CHECKED] **What if...** a node input arg is of the wrong type (e.g. `string` for `math`)? (Verified in `09-errors.test.ts` - Silent fail)
- [STATIC CHECKED] **What if...** a node input port is left unconnected with no default value? -> **Static Error** `Unconnected input port`
- [STATIC CHECKED] **What if...** we connect a `float` output to a `float3` input? -> **Static Error** `Type Mismatch` (No implicit broadcast). User must use `float3(f, f, f)`.
- [STATIC CHECKED] **What if...** we connect a `float3` output to a `float` input? -> **Static Error** `Type Mismatch` (No implicit truncation). User must use swizzle/extract `float3.x`.
- [STATIC CHECKED] **What if...** we try to `vec_mix` vectors of different lengths? (e.g., `float3` and `float4`) -> **Static Error** `Type Mismatch`.
- [STATIC CHECKED] **What if...** we try to convert `int` to `float` (or vice versa)? -> **Static Error** `Type Mismatch`. User must use `static_cast_float` or `static_cast_int`.

## 2. Runtime Math & Numerics
*Execution Level - nuances between JS (CPU) and GLSL/WGSL (GPU)*

- [RUNTIME CHECKED] **What if...** we divide by literal zero (`1.0 / 0.0`)? -> **Infinity** (JS Semantics)
- [RUNTIME CHECKED] **What if...** we divide by a variable that happens to be zero at runtime? -> **Infinity** (JS Semantics)
- [RUNTIME CHECKED] **What if...** we calculate `math_sqrt(-1)`? -> **NaN** (JS Semantics)
- [RUNTIME CHECKED] **What if...** we calculate `math_log(0)` or `math_log(-1)`? -> **-Infinity / NaN** (JS Semantics)
- **What if...** we compute `math_pow(negative, fractional)`? -> **NaN** (JS Semantics)

### Matrix Algebra
- [RUNTIME CHECKED] **What if...** we call `mat_inverse` on a singular matrix? -> **Fallback** (Returns input/Identity - no crash)
- **What if...** `mat_mul` operands are swapped? -> **Logic Error** (Engine executes valid math, user logic issue)

### Integer & Bitwise
- [RUNTIME CHECKED] **What if...** integer overflow? -> **Wrap** (Enforced 32-bit via `static_cast_int`)
- **What if...** negative shift? -> **JS Semantics** (Wrap/Mask)

## 3. Resources & Memory
*Critical for preventing GPU hangs or browser context loss*

### Textures & Samplers
- **What if...** we sample a texture that has size `0x0`? -> **Safe** (Returns 0/Black)
- **What if...** we sample a texture that hasn't been written to yet? -> **Safe** (Returns 0/Black due to undefined check)
- **What if...** we fetch a texel (`texture_load`) with integer coordinates outside `[0, width-1]`? -> **Safe** (Returns 0/Black)
- [STATIC CHECKED] **What if...** we `cmd_resize_resource` on a missing resource ID? (Verified in `09-errors.test.ts`)
- [STATIC CHECKED] **What if...** we `cmd_resize_resource` with invalid format constant? (Verified in `09-errors.test.ts`)
- **What if...** we `cmd_resize_resource` with negative dimensions? -> **Runtime Error** (Should be checked!)

### Buffers
- [STATIC CHECKED] **What if...** we `buffer_store` at a negative index? (Verified in `09-errors.test.ts`)
- [STATIC CHECKED] **What if...** we `buffer_store` at a literal index beyond fixed size? (Verified in `09-errors.test.ts`)
- [RUNTIME CHECKED] **What if...** we `buffer_store` at a dynamic index OOB? (Verified in `03-buffers.test.ts` as Runtime Error)
- **What if...** `buffer_load` reads an index OOB? -> **Safe** (Returns 0)
- **What if...** we write to the same buffer index multiple times in one dispatch? -> **Race Condition** (Unordered)

### Lifecycle
- **What if...** read-after-write hazard? -> **N/A** (CPU is sync) / **GPU Race** (Requires Barriers)
- **What if...** `clearOnResize` behavior? -> **Logic** (Clears if size/format changes or flag set)

## 4. Control Flow & Execution
*Halting problems and logic limits*

### Loops & Branching
- **What if...** a `flow_loop` condition never becomes false? -> **Hang** (Future: Max Ops Limit)
- **What if...** `flow_branch` condition is not a boolean? -> **Auto-Cast** (!!val)
- **What if...** we jump to a node ID that doesn't exist? -> **Runtime Error** (Executor fails to find node)
- [RUNTIME CHECKED] **What if...** a function calls itself? -> **Runtime Error** (Recursion detected)

### Synchronization
- **What if...** atomics? -> **N/A** (CPU is single-threaded)

## 5. Platform & Hardware Limits (WebGPU/OpenGL Specifics)
*Compiling to hardware often imposes strict constraints invisible to a pure CPU interpreter.*

### Feature Enforceability
- **What if...** feature unsupported? -> **N/A** (CPU supports all) / **Compiler Error** (GPU)
- **What if...** atomics on wrong format? -> **Compiler Error** (GPU)

### Limits & Quotas
- **What if...** dispatch size exceeded? -> **N/A** (CPU unlimited) / **Driver Error** (GPU)
- **What if...** binding limits? -> **Driver Error** (GPU)
- **What if...** buffer size limit? -> **Driver Error** (GPU)

### Memory Layout
- **What if...** std140 padding? -> **N/A** (CPU uses packed JS objects) / **Compiler Handling** (GPU)
- **What if...** read-only write? -> **Compiler Error** (GPU)

### Compatibility Fallbacks
- **What if...** features missing? -> **Runtime/Driver Error**
