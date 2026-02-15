# IR & Backend Improvement Opportunities

Tracked opportunities for making the IR more expressive, the generated code leaner, and the backends more consistent. Each item is categorized and roughly prioritized within its section. Difficulty is rated in T-shirt sizes: **XS** (< 1 hr), **S** (half day), **M** (1-2 days), **L** (3-5 days), **XL** (1+ week).

---

## Optimizations

Inefficiencies in generated code caused by missing IR features or overly conservative code generation.

### O1: Relaxed division mode [S]

**Current**: Every `math_div` emits a `safe_div` wrapper that branches on `b != 0`. MSL emits 8 overloaded `safe_div` helpers; WGSL inlines a conditional; CPU-JIT does the same.

**Proposal**: Default `math_div` to relaxed (plain `/`). Add an optional `safe: true` flag (or a separate `math_div_safe` op) for cases where the IR author explicitly needs divide-by-zero protection.

**Files**: `msl-generator.ts:362-368`, `wgsl-generator.ts:1260-1265`, `cpu-jit.ts`

### O2: Redundant `u32()` / `f32()` index casts in WGSL [M]

**Current**: All vector/matrix element access wraps the index in `u32()`, and all vector component constructors wrap args in `f32()`, regardless of whether the expression already has the correct type.

```wgsl
(vec)[u32(already_an_int)]
vec3<f32>(f32(already_a_float), f32(...), f32(...))
```

**Proposal**: Track expression types through code generation and only emit casts when the source type differs from the target.

**Files**: `wgsl-generator.ts:886-891` (vector construction), `wgsl-generator.ts:1109-1121` (element access)

### O3: Unconditional buffer bounds checking [S]

**Current**: Every `buffer_store` in WGSL wraps the write in an `if (u32(idx) < arrayLength(...))` guard. Every `buffer_load` similarly.

**Proposal**: Add an optional `unchecked: true` flag on `buffer_store` / `buffer_load` for cases where the index is known in-bounds (e.g., `global_invocation_id` within dispatch dimensions, fixed-size buffers with statically valid indices). This would eliminate a branch per access in tight compute kernels like the diffusion loop (6 loads + 1 store per voxel).

**Files**: `wgsl-generator.ts:652, 664, 735-736`

---

## Simplifications

IR patterns that are unnecessarily verbose; new ops or features that would make IRs leaner.

### S1: `flat_index_3d` built-in op [S]

**Current**: Computing a flat buffer index from 3D coordinates takes 7-9 nodes per index:
```
swizzle x, swizzle y, swizzle z, mul z*stride_z, mul y*stride_y, add, add, cast_int
```

The raymarch evolve shader repeats this pattern 7 times (self + 6 neighbors), totaling ~60 nodes just for indexing.

**Proposal**: Add `flat_index_3d(coords, size_x, size_y)` that computes `z * size_x * size_y + y * size_x + x` in a single node. Accepts int3 or float3 coords (with implicit floor+cast for float3). Generators emit a single expression.

### S2: Neighbor offset helper for grid simulations [S]

**Current**: The evolve shader computes 6 neighbor indices by manually clamping each axis ±1 and recomputing flat indices from scratch. This accounts for ~40 nodes.

**Proposal**: A `grid_neighbor(gid, axis, direction, grid_size)` op, or more practically, a `clamp_offset(val, offset, min, max)` convenience op that combines `val + offset` and `clamp(result, min, max)` into one node. Even without a dedicated op, a helper function in the IR (`call_func` to a utility) could reduce repetition.

### ~~S3: Missing int-vector dot product~~ [XS] — DONE

Added `vec_dot` signatures for `int2`, `int3`, `int4`. MSL backend emits manual sum-of-products (Metal's `dot()` only supports float vectors). Raymarcher evolve shader refactored to use `vec_dot(gid, int3(1, 32, 1024))` for flat index computation.

### S4: Default blend state shorthand [XS]

**Current**: Alpha blending requires a verbose `pipeline` object on every `cmd_draw`:
```json
"pipeline": {
  "blend": {
    "color": { "srcFactor": "src-alpha", "dstFactor": "one-minus-src-alpha" },
    "alpha": { "srcFactor": "one", "dstFactor": "one-minus-src-alpha" }
  }
}
```

The particle shader and nearly every transparent-rendering effect repeats this exact pattern.

**Proposal**: Support named blend presets as a string shorthand: `"pipeline": { "blend": "alpha" }`. Common presets: `"alpha"` (standard alpha blend), `"additive"` (one/one), `"premultiplied"` (one/one-minus-src-alpha), `"opaque"` (no blend, default).

### S5: `cmd_draw` infers vertex count from buffer [S]

**Current**: `cmd_draw` requires an explicit `count` argument for vertex count. For particle systems and instanced rendering, this is always the buffer size — requiring the CPU function to track it separately (often via a `resource_get_size` node or a hardcoded literal that must match the buffer resize).

**Proposal**: Allow `count` to reference a resource ID directly: `"count": "particles"`. The runtime resolves it to the buffer's element count. This eliminates a common source of desync bugs where the buffer is resized but the draw count isn't updated.

### S6: Struct buffer ergonomics [M]

**Current**: Accessing struct fields from a buffer requires two nodes:
```json
{ "id": "p", "op": "buffer_load", "buffer": "particles", "index": "vi" },
{ "id": "pos", "op": "struct_extract", "struct": "p", "field": "position" }
```

For particle systems with many fields (position, velocity, color, life, size), this means 2N nodes just to unpack one particle.

**Proposal**: Allow `buffer_load` to accept an optional `field` argument: `{ "op": "buffer_load", "buffer": "particles", "index": "vi", "field": "position" }`. This collapses load+extract into one node. The validator infers the output type from the struct's field type.

---

## Inconsistencies

Behavioral differences between backends (WGSL/WebGPU, MSL/Metal, C++/CPU, CPU-JIT/JS).

### I1: Float modulo — `%` vs `fmod()` [XS]

**Current**: MSL explicitly checks the inferred type and uses `%` for ints, `fmod()` for floats. WGSL uses `%` for everything (which is valid in WGSL but has different semantics from `fmod` for negative values). CPU-JIT uses JS `%`.

**Behavior difference**: For negative operands, C `fmod(-7, 3)` = `-1`, WGSL `(-7) % 3` = `-1` (truncated), JS `(-7) % 3` = `-1`. These happen to agree, but the code paths are different and the coincidence isn't documented.

**Files**: `msl-generator.ts:1230-1237`, `wgsl-generator.ts` (math_mod case)

### I2: Division by zero behavior [M]

**Current**: WGSL generator detects literal `/ 0` at codegen time and emits `get_inf()`. MSL and C++ emit plain `/` which is UB for integers and returns `±inf`/`NaN` for floats (platform-dependent). CPU-JIT returns JS `Infinity`/`NaN`.

**Behavior difference**: Integer division by zero is UB in C++ but well-defined in WGSL and JS. Float division by zero may produce `inf`, `nan`, or trap depending on platform fast-math settings.

**Files**: `wgsl-generator.ts:1260-1265` (literal check), `msl-generator.ts:1202`

### I3: Vector constructor type coercion [S]

**Current**: WGSL wraps all vector constructor args in explicit `f32()` casts. MSL does not — it relies on implicit C++ constructor overloading. C++ generator uses explicit `float()` casts.

**Behavior difference**: If a component is `int` type:
- WGSL: `f32(intVal)` — explicit, correct
- MSL: `float3(intVal, ...)` — implicit conversion, may warn
- CPU-JIT: JS coercion, always works

This hasn't caused test failures yet but is fragile.

**Files**: `wgsl-generator.ts:886-891`, `msl-generator.ts:1132-1134`

### I4: Comparison operators return type [M]

**Current**: MSL uses helper functions that return `float` (0.0 or 1.0) for scalar comparisons and `floatN` for vector comparisons. WGSL comparisons return `bool`/`vecN<bool>` natively but the generator converts to float for IR compatibility.

**Behavior difference**: Intermediate boolean representations differ. If a comparison result feeds into `math_mul`, MSL gets `float * float` while WGSL may get `bool * float` (which requires an implicit cast). The generators handle this, but the approaches diverge.

**Files**: `msl-generator.ts:371-394` (cmp helpers), `wgsl-generator.ts` (comparison handling)

### I5: `mat_inverse` fallback [S]

**Current**: If a matrix is singular, `mat_inverse` returns the input matrix unchanged (MSL) vs zeros (CPU-JIT) vs undefined (WGSL, platform-dependent). The conformance test (`12-runtime-edge-cases.test.ts`) checks for 0, suggesting zeros is the intended behavior.

**Proposal**: Document and enforce a consistent fallback (return zero matrix) across all backends.

### I6: Fast-math differences [S]

**Current**: Metal fast-math is explicitly disabled (`compileOptions.fastMathEnabled = NO`). WGSL relies on browser/driver behavior. C++ uses default compiler settings.

**Behavior difference**: Without explicit control, NaN propagation, tanh overflow, and denormal handling can vary. The Metal fast-math fix is documented in MEMORY.md but there's no equivalent safeguard for WGSL or C++.

**Files**: `cpp-harness.mm` (Metal compile options)

### I7: Integer overflow / wrapping [M]

**Current**: MSL uses a `safe_cast_int` helper that wraps on overflow: `if (v >= 2147483648.0f) return int(v - 4294967296.0f)`. WGSL relies on native `i32()` truncation. CPU-JIT uses JS `|0` or `Math.trunc`. C++ has UB for signed integer overflow.

**Behavior difference**: `int(2147483648.0)` gives different results across backends without the safe-cast helper.

**Files**: `msl-generator.ts:440-444` (safe_cast_int), `wgsl-generator.ts` (native i32), `cpu-jit.ts`


> **Note**: Architecture-level items (retained buffer lifecycle, staging texture reuse, cross-API synchronization) have been moved to `docs/CPPMETAL_DESIGN.md` § Known Issues.
