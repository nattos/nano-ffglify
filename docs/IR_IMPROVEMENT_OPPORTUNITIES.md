# IR & Backend Improvement Opportunities

Tracked opportunities for making the IR more expressive, the generated code leaner, and the backends more consistent. Each item is categorized and roughly prioritized within its section.

---

## Optimizations

Inefficiencies in generated code caused by missing IR features or overly conservative code generation.

### O1: Relaxed division mode

**Current**: Every `math_div` emits a `safe_div` wrapper that branches on `b != 0`. MSL emits 8 overloaded `safe_div` helpers; WGSL inlines a conditional; CPU-JIT does the same.

**Proposal**: Default `math_div` to relaxed (plain `/`). Add an optional `safe: true` flag (or a separate `math_div_safe` op) for cases where the IR author explicitly needs divide-by-zero protection.

**Files**: `msl-generator.ts:362-368`, `wgsl-generator.ts:1260-1265`, `cpu-jit.ts`

### O2: Redundant `u32()` / `f32()` index casts in WGSL

**Current**: All vector/matrix element access wraps the index in `u32()`, and all vector component constructors wrap args in `f32()`, regardless of whether the expression already has the correct type.

```wgsl
(vec)[u32(already_an_int)]
vec3<f32>(f32(already_a_float), f32(...), f32(...))
```

**Proposal**: Track expression types through code generation and only emit casts when the source type differs from the target.

**Files**: `wgsl-generator.ts:886-891` (vector construction), `wgsl-generator.ts:1109-1121` (element access)

### O3: Unconditional buffer bounds checking

**Current**: Every `buffer_store` in WGSL wraps the write in an `if (u32(idx) < arrayLength(...))` guard. Every `buffer_load` similarly.

**Proposal**: Add an optional `unchecked: true` flag on `buffer_store` / `buffer_load` for cases where the index is known in-bounds (e.g., `global_invocation_id` within dispatch dimensions, fixed-size buffers with statically valid indices). This would eliminate a branch per access in tight compute kernels like the diffusion loop (6 loads + 1 store per voxel).

**Files**: `wgsl-generator.ts:652, 664, 735-736`

### O4: Dead helper elimination in MSL

**Current**: The MSL generator unconditionally emits ~40 helper functions (`safe_div` x8, `cmp_*` x24, `msl_select` x7, `msl_is_*` x12, `safe_cast_int`), even if the shader uses none of them.

**Proposal**: Track which helpers are actually referenced during code generation, and only emit those. Could use a simple set of "needed helpers" populated during `emitPure`/`emitChain`.

**Files**: `msl-generator.ts:362-444`

### O5: Literal int arithmetic forces float round-trip

**Current**: The validator types all numeric literals as `float`. So `math_mul(int_var, 1024)` is resolved as `float * float`, and the WGSL coercion system may emit unnecessary `f32()` casts. The raymarch shader works around this by doing index math in float and casting back to int at the end.

**Proposal**: Related to S4 (typed literals). If the IR could express `1024` as an int literal, the entire float-index-then-cast-back pattern disappears, saving ~2 nodes per flat index computation and eliminating potential precision issues for large indices.

**Files**: `ir/validator.ts` (processArg), `wgsl-generator.ts` (resolveCoercedArgs)

---

## Simplifications

IR patterns that are unnecessarily verbose; new ops or features that would make IRs leaner.

### S1: `flat_index_3d` built-in op

**Current**: Computing a flat buffer index from 3D coordinates takes 7-9 nodes per index:
```
swizzle x, swizzle y, swizzle z, mul z*stride_z, mul y*stride_y, add, add, cast_int
```

The raymarch evolve shader repeats this pattern 7 times (self + 6 neighbors), totaling ~60 nodes just for indexing.

**Proposal**: Add `flat_index_3d(coords, size_x, size_y)` that computes `z * size_x * size_y + y * size_x + x` in a single node. Accepts int3 or float3 coords (with implicit floor+cast for float3). Generators emit a single expression.

### S2: Typed literals

**Current**: All numeric literals in IR are typed as `float` by the validator, even `0` or `1024`. This forces the two-pass signature matching in the validator and causes WGSL coercion issues when mixing int variables with literal constants.

**Proposal**: Allow `literal` nodes to carry an explicit type:
```json
{ "id": "stride", "op": "literal", "val": 1024, "type": "int" }
```
The validator would respect the declared type instead of always inferring `float`. Untyped literals keep the current `float` default for backward compatibility.

### S3: Scalar-to-vector broadcast op

**Current**: Constructing a uniform vector like `float3(0.5, 0.5, 0.5)` requires either a literal node + float3 with repeated refs, or three separate literal expressions. Generators can't detect this pattern.

**Proposal**: Add `vec_broadcast(val, type)` or detect when all components of a `float3`/`float4` reference the same node and emit `vec3<f32>(val)` instead of `vec3<f32>(val, val, val)`. Minor code size savings, but makes IR intent clearer.

### S4: `vec_swizzle` already handles reorder — document it

**Current**: `vec_swizzle` with multi-character channels like `'yzx'` already produces a reordered vector. But the IR examples don't use this — they swizzle individual components and reassemble via `float3(y, x, z)`.

**Proposal**: This is mostly a documentation/example issue. The existing `vec_swizzle` with `channels: 'yzx'` should work. Verify all backends handle multi-channel swizzle→new-vector correctly and update examples to use it.

### S5: Neighbor offset helper for grid simulations

**Current**: The evolve shader computes 6 neighbor indices by manually clamping each axis ±1 and recomputing flat indices from scratch. This accounts for ~40 nodes.

**Proposal**: A `grid_neighbor(gid, axis, direction, grid_size)` op, or more practically, a `clamp_offset(val, offset, min, max)` convenience op that combines `val + offset` and `clamp(result, min, max)` into one node. Even without a dedicated op, a helper function in the IR (`call_func` to a utility) could reduce repetition.

### S6: Missing int-vector dot product

**Current**: No `vec_dot` signature for `int3 * int3 -> int`. The flat index pattern `z*1024 + y*32 + x` is really `dot(int3(x,y,z), int3(1, 32, 1024))`. With an int dot product, this becomes a single node.

**Proposal**: Add `vec_dot` signatures for `int2`, `int3`, `int4`. Combined with S2 (typed int literals), the entire flat index computation becomes: `vec_dot(gid, int3(1, 32, 1024))`.

---

## Inconsistencies

Behavioral differences between backends (WGSL/WebGPU, MSL/Metal, C++/CPU, CPU-JIT/JS).

### I1: Float modulo — `%` vs `fmod()`

**Current**: MSL explicitly checks the inferred type and uses `%` for ints, `fmod()` for floats. WGSL uses `%` for everything (which is valid in WGSL but has different semantics from `fmod` for negative values). CPU-JIT uses JS `%`.

**Behavior difference**: For negative operands, C `fmod(-7, 3)` = `-1`, WGSL `(-7) % 3` = `-1` (truncated), JS `(-7) % 3` = `-1`. These happen to agree, but the code paths are different and the coincidence isn't documented.

**Files**: `msl-generator.ts:1230-1237`, `wgsl-generator.ts` (math_mod case)

### I2: Division by zero behavior

**Current**: WGSL generator detects literal `/ 0` at codegen time and emits `get_inf()`. MSL and C++ emit plain `/` which is UB for integers and returns `±inf`/`NaN` for floats (platform-dependent). CPU-JIT returns JS `Infinity`/`NaN`.

**Behavior difference**: Integer division by zero is UB in C++ but well-defined in WGSL and JS. Float division by zero may produce `inf`, `nan`, or trap depending on platform fast-math settings.

**Files**: `wgsl-generator.ts:1260-1265` (literal check), `msl-generator.ts:1202`

### I3: Vector constructor type coercion

**Current**: WGSL wraps all vector constructor args in explicit `f32()` casts. MSL does not — it relies on implicit C++ constructor overloading. C++ generator uses explicit `float()` casts.

**Behavior difference**: If a component is `int` type:
- WGSL: `f32(intVal)` — explicit, correct
- MSL: `float3(intVal, ...)` — implicit conversion, may warn
- CPU-JIT: JS coercion, always works

This hasn't caused test failures yet but is fragile.

**Files**: `wgsl-generator.ts:886-891`, `msl-generator.ts:1132-1134`

### I4: Comparison operators return type

**Current**: MSL uses helper functions that return `float` (0.0 or 1.0) for scalar comparisons and `floatN` for vector comparisons. WGSL comparisons return `bool`/`vecN<bool>` natively but the generator converts to float for IR compatibility.

**Behavior difference**: Intermediate boolean representations differ. If a comparison result feeds into `math_mul`, MSL gets `float * float` while WGSL may get `bool * float` (which requires an implicit cast). The generators handle this, but the approaches diverge.

**Files**: `msl-generator.ts:371-394` (cmp helpers), `wgsl-generator.ts` (comparison handling)

### I5: `mat_inverse` fallback

**Current**: If a matrix is singular, `mat_inverse` returns the input matrix unchanged (MSL) vs zeros (CPU-JIT) vs undefined (WGSL, platform-dependent). The conformance test (`12-runtime-edge-cases.test.ts`) checks for 0, suggesting zeros is the intended behavior.

**Proposal**: Document and enforce a consistent fallback (return zero matrix) across all backends.

### I6: Fast-math differences

**Current**: Metal fast-math is explicitly disabled (`compileOptions.fastMathEnabled = NO`). WGSL relies on browser/driver behavior. C++ uses default compiler settings.

**Behavior difference**: Without explicit control, NaN propagation, tanh overflow, and denormal handling can vary. The Metal fast-math fix is documented in MEMORY.md but there's no equivalent safeguard for WGSL or C++.

**Files**: `cpp-harness.mm` (Metal compile options)

### I7: Integer overflow / wrapping

**Current**: MSL uses a `safe_cast_int` helper that wraps on overflow: `if (v >= 2147483648.0f) return int(v - 4294967296.0f)`. WGSL relies on native `i32()` truncation. CPU-JIT uses JS `|0` or `Math.trunc`. C++ has UB for signed integer overflow.

**Behavior difference**: `int(2147483648.0)` gives different results across backends without the safe-cast helper.

**Files**: `msl-generator.ts:440-444` (safe_cast_int), `wgsl-generator.ts` (native i32), `cpu-jit.ts`
