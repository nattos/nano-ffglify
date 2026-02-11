# Type Coercion Inconsistencies across Generators

This document outlines the differences in how various code generators handle type coercions (e.g., mixing floats and ints in math operations).

## Current Strategies

| Generator | Coercion Strategy | Unification Logic | Broadcasting |
|-----------|-------------------|-------------------|--------------|
| **MSL / CPP** | `resolveCoercedArgs` helper | Has `'unify'` mode; if any arg is float, all become float. | Uses explicit vector constructors or native support. |
| **WGSL** | Local `arg` / `cmp` helpers | Checks args against expected output type (`isFloatResult`). | Explicit `broadcast` helper for scalars to vectors. |
| **JS (JIT)** | Explicit IR ops only | None. Relies on JavaScript's dynamic typing. | None. Relies on `_applyBinary` to handle scalar/vector mixing (if implemented in library). |

## Identified Inconsistencies

### 1. Mixed Type Math (Float + Int)
- **Metal (MSL/CPP)**: Properly unified if `'unify'` mode is used. If `math_add` is called with `[float, int]`, the `int` is cast to `float`.
- **WGSL**: Coerces arguments based on the *expected* output type. If the output is inferred as `float`, it casts `int` inputs to `f32()`. If output is `int`, it casts `float` inputs to `i32()`.
- **JS (JIT)**: No automatic casting. `1.0 + 2` works because of JS, but might lose precision or behave differently if IR expects specific bit-widths.

### 2. Comparison Results
- **WGSL**: Has a `cmp` helper that wraps boolean results in `select(0.0, 1.0, expr)` if a float result is expected.
- **Metal**: Managed via `resolveCoercedArgs` in specific nodes, but lacks a centralized "boolean to float" wrapper for all comparison ops in the same way WGSL's `cmp` does.
- **JS (JIT)**: Explicitly converts to `1.0 : 0.0` in `compileExpression` for `math_gt`, `math_lt`, etc.

### 3. Scalar-to-Vector Broadcasting
- **WGSL**: Has explicit `broadcast(arg, targetType)` logic for `math_add`, `math_sub`, `math_div`, `math_mod`, `math_atan2`, `math_mad`, and `math_clamp`.
- **Metal**: MSL and C++ often support some broadcasting natively, but the generators often output explicit `vec4<f32>(x, x, x, x)`-style constructors.
- **JS (JIT)**: No broadcasting logic in the generator. It depends on `_applyBinary` in `intrinsics.js` to handle mixing a scalar with an array.

### 4. Vector-to-Vector Unification
- **Metal**: `'unify'` mode handles `float` vs `int` well but doesn't necessarily upscale `vec2` to `vec4`.
- **WGSL**: Broadcasting specifically handles scalar-to-vector but not `vec2`-to `vec4`.

## Recommendations

1. **Unify `resolveCoercedArgs`**: Adopt the `resolveCoercedArgs` pattern from Metal across all generators to provide a consistent "Type Unification" layer.
2. **Move Broadcasting to Helper**: Extract WGSL's broadcasting logic into a shared utility or implement it consistently in all `resolveCoercedArgs` implementations.
3. **Explicit Coercion in JIT**: Even though JS is loose, the JIT should probably include bit-wise or numeric coercions to better match GPU behavior (e.g., `(x | 0)` for ints).
