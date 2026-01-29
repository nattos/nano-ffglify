# IR Engine Edge Cases & Failure Modes

A comprehensive list of potential edge cases to test for compliance, robustness, and stability across CPU and GPU environments.

## 1. Type System & Static Structure
*Compiler/Validation Level*

### Dimensionality & Swizzling
- **What if...** we request a swizzle mask longer than the output type? (e.g., `vec3` result from `vec4.xyzw`)
- **What if...** we swizzle components that don't exist? (e.g., `vec2.z`)
- **What if...** we try to `vec_mix` vectors of different lengths? (e.g., `vec3` and `vec4`)
- **What if...** a matrix constructor (`mat4`) is provided with too few or too many arguments?
- **What if...** we access a matrix column index that is out of bounds (e.g., `col[4]` on `mat4`)?
- [STATIC CHECKED] **What if...** we attempt math operations on incompatible types (Scalar vs Vector)? (Verified in `09-errors.test.ts`)
- [STATIC CHECKED] **What if...** we use `vec_dot` on vectors of mismatched lengths? (Verified in `09-errors.test.ts`)
- [STATIC CHECKED] **What if...** we use `mat_mul` on mismatched dimensions (Mat4 x Vec3)? (Verified in `09-errors.test.ts`)

### Structs & Composition
- **What if...** we define a struct that recursively contains itself? (Infinite size)
- **What if...** two structs share the same `id` but have different member definitions?
- [STATIC CHECKED] **What if...** we use `struct_extract` on a key that doesn't exist (or on a non-struct)? (Verified in `09-errors.test.ts`)
- **What if...** we `struct_construct` with missing fields? Does it zero-init or fail?

### Functions & Signals
- [STATIC CHECKED] **What if...** a node input arg is missing (e.g. `math_add` missing `b`)? (Verified in `09-errors.test.ts` - Undefined behavior)
- [STATIC CHECKED] **What if...** a node input arg is of the wrong type (e.g. `string` for `math`)? (Verified in `09-errors.test.ts` - Silent fail)
- **What if...** a node input port is left unconnected with no default value?
- **What if...** we connect a `float` output to a `vec3` input? (Implicit cast vs Error)
- **What if...** we connect a `vec3` output to a `float` input? (Truncation vs Error)

## 2. Runtime Math & Numerics
*Execution Level - nuances between JS (CPU) and GLSL/WGSL (GPU)*

### Arithmetic Limits
- **What if...** we divide by literal zero (`1.0 / 0.0`)?
  - *CPU:* `Infinity`
  - *GPU:* Undefined/Infinity/Zero depending on driver.
- **What if...** we divide by a variable that happens to be zero at runtime?
- [RUNTIME CHECKED] **What if...** we calculate `math_sqrt(-1)`? (Currently returns NaN, should error/warn?)
- **What if...** we calculate `math_log(0)` or `math_log(-1)`?
- **What if...** we compute `math_pow(negative, fractional)`?

### Matrix Algebra
- **What if...** we call `mat_inverse` on a singular matrix (determinant is 0)?
- **What if...** `mat_mul` operands are swapped? (A*B vs B*A - logical error, not runtime, but important)

### Integer & Bitwise
- **What if...** an integer addition overflows 32-bit range? (Wrap vs Clamp vs JS double precision behavior)
- **What if...** we shift bits by a negative amount or >= 32?

## 3. Resources & Memory
*Critical for preventing GPU hangs or browser context loss*

### Textures & Samplers
- **What if...** we sample a texture that has size `0x0`?
- **What if...** we sample a texture that hasn't been written to yet? (Uninitialized data)
- **What if...** we fetch a texel (`texture_load`) with integer coordinates outside `[0, width-1]`?
- [STATIC CHECKED] **What if...** we `cmd_resize_resource` on a missing resource ID? (Verified in `09-errors.test.ts`)
- [STATIC CHECKED] **What if...** we `cmd_resize_resource` with invalid format constant? (Verified in `09-errors.test.ts`)
- **What if...** we `cmd_resize_resource` with negative dimensions?

### Buffers
- [STATIC CHECKED] **What if...** we `buffer_store` at a negative index? (Verified in `09-errors.test.ts`)
- [STATIC CHECKED] **What if...** we `buffer_store` at a literal index beyond fixed size? (Verified in `09-errors.test.ts`)
- [RUNTIME CHECKED] **What if...** we `buffer_store` at a dynamic index OOB? (Verified in `03-buffers.test.ts` as Runtime Error)
- **What if...** `buffer_load` reads an index OOB? (Returns 0 or garbage?)
- **What if...** we write to the same buffer index multiple times in one dispatch? (Race condition)

### Lifecycle
- **What if...** we read from a resource in the same pass that we write to it? (Read-After-Write hazard - requires ping-ponging or barriers)
- **What if...** `clearOnResize` is true, but the resize command sets the same size? (Should it still clear?)

## 4. Control Flow & Execution
*Halting problems and logic limits*

### Loops & Branching
- **What if...** a `flow_loop` condition never becomes false? (Infinite loop)
- **What if...** `flow_branch` condition is not a boolean (e.g. `0.0` or `null`)?
- **What if...** we jump to a node ID that doesn't exist?
- **What if...** a function calls itself? (Recursion is forbidden, but does it crash the compiler?)

### Synchronization
- **What if...** `atomic_counter` is incremented by 1000 threads simultaneously? is the result exact?

## 5. Platform & Hardware Limits (WebGPU/OpenGL Specifics)
*Compiling to hardware often imposes strict constraints invisible to a pure CPU interpreter.*

### Feature Enforceability
- **What if...** we request `linear` filtering on an `rgba32float` texture?
  - *Context:* Many WebGPU implementations (and mobile GL) do not support filterable 32-bit float textures without extensions.
  - *Expected:* Compiler Error vs Fallback to `nearest`?
- **What if...** we use `atomic_counter` on a format that doesn't support atomics? (e.g. `rgba8`?)

### Limits & Quotas
- **What if...** `cmd_dispatch` dimensions exceed the hardware limit? (e.g. > 65535 on some axes)
- **What if...** the number of active textures exceeds the bind slot limit (usually 8 or 16 guaranteed)?
- **What if...** a Uniform Buffer is larger than `maxUniformBufferBindingSize` (often just 64KB)?
  - *Strategy:* Automatically promote to Storage Buffer? Or Error?

### Memory Layout
- **What if...** a Struct used in a Uniform Buffer violates `std140` padding rules?
  - *Example:* A `float` followed by a `vec3`. In `std140`, `vec3` must be 16-byte aligned, causing a gap.
  - *Risk:* CPU writes to offset 4, GPU reads from offset 16. Mismatch.
- **What if...** we try to write to a `read_only` storage buffer from a shader?

### Compatibility Fallbacks
- **What if...** the device does not support `timestamp-query` for profiling?
- **What if...** we request a texture format (`r16f`) not supported by the implementation?
