# C++ / Metal Backend Design

## Goal

Execute the Nano-FFGLify IR natively on macOS using C++ for CPU host logic and Metal for GPU compute and rendering. This backend serves two purposes:

1. **Conformance testing** — validates IR semantics against a native GPU implementation (complementing the WebGPU/WGSL backend).
2. **FFGL plugin export** — compiles IR graphs into standalone macOS FFGL plugins that run in VJ hosts like Resolume Arena.

## Architecture

The backend uses **dual code generation**: C++ for CPU-side control flow and Metal Shading Language (MSL) for GPU shaders. Both are compiled ahead-of-time into a single native executable (test harness) or dynamic library (FFGL plugin).

### Components

1. **CppGenerator** (`src/metal/cpp-generator.ts`)
   - Compiles CPU-type IR functions to C++ source code.
   - Emits `cmd_dispatch` as `ctx.dispatchShader(...)` and `cmd_draw` as `ctx.draw(...)`.
   - Flattens typed shader arguments into a `std::vector<float>` for GPU marshalling.

2. **MslGenerator** (`src/metal/msl-generator.ts`)
   - Compiles shader-type IR functions to MSL.
   - Handles compute kernels (`kernel void`), vertex functions (`vertex`), and fragment functions (`fragment`).
   - Unpacks the flat float buffer back into typed locals at shader entry.

3. **C++ Intrinsics** (`src/metal/intrinsics.incl.h`)
   - Provides `EvalContext` — the runtime context for Metal dispatch, resource management, and GPU synchronization.
   - Includes vector/matrix math helpers (`std::array<T,N>` with operator overloads).
   - Manages Metal pipeline creation, buffer/texture binding, and staging textures.

4. **Test Harness** (`src/metal/cpp-harness.mm`)
   - Standalone executable that loads a `.metallib`, parses resource specs and inputs, runs `func_main(ctx)`, and outputs results as JSON.

5. **FFGL Plugin** (`src/metal/ffgl-plugin.mm`)
   - Wraps generated code as a macOS FFGL plugin bundle.
   - Handles Metal↔OpenGL interop via IOSurface-backed `InteropTexture`.

### Data Flow

```
IR Document
  ├─ CppGenerator ──→ logic.cpp   (CPU host: control flow, arg flattening)
  └─ MslGenerator ──→ shaders.metal  (GPU: compute/vertex/fragment)
         │                    │
         │              xcrun metal → default.metallib
         │                    │
    clang++ ──────────────────┘
         │
    Native executable / FFGL bundle
         │
    Execution:
      func_main(ctx)
        → ctx.dispatchShader() → Metal compute pipeline
        → ctx.draw()           → Metal render pipeline
        → ctx.blitStagingToExternal() → IOSurface output
```

## GPU Marshalling: Flat Float Buffer

The central design decision is **flat float buffer marshalling**. All shader arguments are serialized as contiguous floats on the C++ side and deserialized into typed locals on the MSL side. This avoids Metal struct alignment issues entirely.

### C++ Side: `emitArgFlattening()`

The C++ generator recursively flattens each shader input into a `std::vector<float>`:

| IR Type | Encoding |
|---------|----------|
| `float` | 1 float |
| `int`, `bool` | 1 float (cast via `static_cast<float>`) |
| `float2/3/4` | 2/3/4 floats |
| `int2/3/4` | 2/3/4 floats (cast) |
| `float3x3/4x4` | 9/16 floats |
| struct | Recursive: flatten each member in declaration order |
| `array<T, N>` (fixed) | N elements, each flattened |
| `T[]` (dynamic) | Length as 1 float, then elements |

CPU-allowed builtins (`time`, `delta_time`, `bpm`, etc.) are appended after the function inputs. The `output_size` builtin (int3) is appended after CPU-allowed builtins when the shader uses it.

### MSL Side: `emitInputUnpacking()`

The MSL generator reads from `constant float* inputs [[buffer(0)]]` using a running offset that mirrors the C++ flattening order:

```metal
kernel void fn_shader(
    constant float* inputs [[buffer(0)]],
    texture2d<float, access::write> tex_output [[texture(1)]],
    uint3 gid [[thread_position_in_grid]]
) {
    int _offset = 0;
    float v_speed = inputs[_offset]; _offset += 1;
    float3 v_color = float3(inputs[_offset], inputs[_offset+1], inputs[_offset+2]); _offset += 3;
    // ... builtins ...
    // shader body
}
```

**Critical invariant**: The flattening order in C++ must exactly match the unpacking order in MSL. Both generators traverse inputs in the same canonical order (function inputs → CPU builtins → output_size).

### Resource Bindings

Resources are bound at sequential indices starting from 1:

| Binding | Content |
|---------|---------|
| 0 | `constant float* inputs` (globals buffer) |
| 1 | Output texture/buffer (first resource) |
| 2+ | Input textures, then internal resources |

The binding order is established by `CppGenerator` and must be consistent with `MslGenerator`.

## Shader Stages

### Compute Kernels

Emitted via `emitKernel()`. Entry point signature:

```metal
kernel void fn_name(
    constant float* inputs [[buffer(0)]],
    texture2d<float, access::write> tex_0 [[texture(1)]],
    device float* buf_1 [[buffer(2)]],
    uint3 gid [[thread_position_in_grid]]
) { ... }
```

Dispatched via `ctx.dispatchShader(name, dimX, dimY, dimZ, args)`.

### Vertex / Fragment Functions

Emitted via `emitStageFunction()`. Use Metal stage attributes:

```metal
struct VertexOut {
    float4 position [[position]];
    // interpolated outputs...
};

vertex VertexOut fn_vertex(
    constant float* inputs [[buffer(0)]],
    uint vid [[vertex_id]]
) { ... }

fragment float4 fn_fragment(
    constant float* inputs [[buffer(0)]],
    VertexOut stage_in [[stage_in]]
) { ... }
```

Dispatched via `ctx.draw(targetIdx, vsFunc, fsFunc, vertexCount, args)`.

## FFGL Plugin: Metal↔OpenGL Interop

The FFGL plugin operates within an OpenGL host (e.g., Resolume Arena). Metal rendering results must be presented through OpenGL.

### IOSurface Sharing

`InteropTexture` (`src/metal/InteropTexture.m`) creates a `CVPixelBuffer` with both Metal and OpenGL compatibility. Both APIs get texture views backed by the same IOSurface:

- **Metal**: `CVMetalTextureCacheCreateTextureFromImage` → `CVMetalTextureGetTexture`
- **OpenGL**: `CVOpenGLTextureCacheCreateTextureFromImage` → `CVOpenGLTextureGetName`

### Staging Texture Pattern

IOSurface-backed Metal textures may lack `MTLTextureUsageShaderWrite`. The backend creates internal staging textures (`MTLStorageModeShared`, full usage) for shader work, then blits results to the external IOSurface texture:

```
Input:  GL Host Texture → IOSurface → blitExternalToStaging → Staging Texture → Shader reads
Output: Shader writes → Staging Texture → blitStagingToExternal → IOSurface → glBlitFramebuffer → GL Host FBO
```

### Cross-API Synchronization

The synchronization model follows Apple's recommended IOSurface interop pattern (ref: [Developer Forums thread 694201](https://developer.apple.com/forums/thread/694201)):

| Direction | Sync Mechanism | Why |
|-----------|---------------|-----|
| GL → Metal (inputs) | `glFlush()` before Metal reads | Submits GL writes to GPU; IOSurface handles coherency |
| Metal → Metal (same queue) | Implicit command buffer ordering | Same-queue guarantee: later buffers start after earlier ones complete |
| Metal → GL (output) | `[cmdBuffer waitUntilScheduled]` after blit commit | Ensures Metal blit is queued before GL reads the IOSurface |

**Key invariants**:
- `synchronizeTexture` is **NOT** needed for IOSurface textures — it syncs GPU→CPU for managed storage, but GL reads via IOSurface directly, not CPU memory.
- `waitUntilCompleted` is **NOT** needed in `blitExternalToStaging()` — same-queue ordering handles Metal→Metal dependencies.
- `waitUntilScheduled` **IS** needed in `blitStagingToExternal()` — prevents GL from reading stale IOSurface data.
- `glFlush()` **IS** needed before Metal reads IOSurface input textures.

### Output Blit

The final output uses `glBlitFramebuffer` (not a shader-based quad blit) to copy from the IOSurface FBO to the host FBO. This handles cross-texture-type transfers (`GL_TEXTURE_RECTANGLE` IOSurface → `GL_TEXTURE_2D` host FBO) reliably.

## Test Harness

The test harness (`src/metal/cpp-harness.mm`) is a standalone executable:

```bash
./metal-gpu-harness default.metallib \
  -i time:1.5 -i delta_time:0.016 \
  -d data.json \
  T:256:256:0 B:1000:4
```

**Arguments**:
- First arg: path to `.metallib` (enables GPU; omit for CPU-only tests)
- `-i name:value`: scalar inputs
- `-d datafile.json`: pre-populated resource data (flat float arrays keyed by resource index)
- Resource specs: `T:width:height:wrapMode` (texture, wrap: 0=repeat, 1=clamp) or `B:size:stride` (buffer, stride from dataType)

**Output**: JSON with resource data, action log, and optional return value. Float precision uses `std::setprecision(10)` for accurate round-trip. Special values: NaN → `null`, ±Inf → `1e999`/`-1e999`.

**Caching**: The compiled harness binary is cached at `os.tmpdir()/nano-ffglify-metal-harness/`. Delete this directory after modifying `cpp-harness.mm` or `intrinsics.incl.h`.

## Metal Compilation

Metal shaders are compiled via `xcrun`:

```bash
xcrun -sdk macosx metal -c shaders.metal -o shaders.air
xcrun -sdk macosx metallib shaders.air -o default.metallib
```

**Important**: Fast-math is disabled (`compileOptions.fastMathEnabled = NO` in the harness) because Metal's default fast-math breaks IEEE 754 semantics — NaN comparisons, `tanh` overflow, and infinity handling all become unreliable.

## Known Issues

### 1. Recursion Detection
- **Status**: Not implemented in MSL generator
- **Impact**: Mutual recursion (A→B→A) fails with cryptic MSL compile error instead of friendly "Recursion detected" message
- **Location**: `collectFunctions` in `msl-generator.ts`

### 2. Dynamic Resource Sizing
- **Status**: Static only
- **Impact**: `resource_get_size` only works for `size.mode: 'fixed'` with `size.value`. Dynamic/expression-based sizes not supported.
- **TODO**: Pass resource sizes as kernel parameters and query at runtime

### 3. Retained Buffer Resize
- **Status**: Not handled
- **Impact**: `retainedMetalBuffer` is created once and never resized. If `cmd_resize_resource` changes a buffer's size, the retained buffer becomes stale. Masked by particle systems that resize only at init.
- **Fix**: Detect `res->data.size() != retainedMetalBuffer.length / sizeof(float)` in `syncToMetal()` and reallocate.

### 4. Staging Texture Allocation
- **Status**: Per-frame allocation
- **Impact**: `syncToMetal()` creates new staging textures every frame for IOSurface-backed external textures. Should cache and reuse when dimensions/format haven't changed.

### 5. `vec_get_element` on Matrices in Helper Functions
- **Status**: Pre-existing limitation
- **Impact**: `vec_get_element` on matrices in non-entry MSL/WGSL helper functions lacks type detection. Works correctly in entry-point functions.

## Implementation Status

### Conformance Tests
- **669 passing / 0 failing / 3 skipped** (out of 672 total)
- Skipped: `17-render-pipeline` for CppMetal (vertex/fragment pipeline partially implemented)
- Metal-specific tests: `15-gpu-marshalling`, `16-gpu-stress`, `26-function-params`

### FFGL Plugin
- Compute shader effects: working
- Particle systems (compute + vertex/fragment): working
- Input texture blitting: working (shader-based, not yet stress-tested with complex inputs)
- Multi-pass effects: working

### Test Commands
```bash
# All conformance tests (default backend)
npx vitest run src/tests/conformance/

# CppMetal backend specifically
TEST_BACKEND=CppMetal npx vitest run src/tests/conformance/

# Single test file
TEST_BACKEND=CppMetal npx vitest run src/tests/conformance/15-gpu-marshalling.test.ts

# FFGL build tests
npx vitest run src/tests/conformance/integration-particle.test.ts
```
