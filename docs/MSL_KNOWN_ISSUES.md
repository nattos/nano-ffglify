# MSL Backend - Known Issues

## Open Issues

### 1. Recursion Detection
- **Status**: Not implemented
- **Impact**: Mutual recursion (A→B→A) fails with cryptic MSL compile error instead of friendly "Recursion detected" message
- **Location**: `collectFunctions` in `msl-generator.ts`
- **Test**: `04-functions.test.ts` - "should throw Error on Recursion"

### 2. Dynamic Resource Sizing
- **Status**: Static only
- **Impact**: `resource_get_size` only works for `size.mode: 'fixed'` with `size.value`. Dynamic/expression-based sizes not supported.
- **Location**: [msl-generator.ts:L595](file:///Users/nattos/Code/nano-ffglify/src/metal/msl-generator.ts#L595)
- **TODO**: Pass resource sizes as kernel parameters and query at runtime

### 3. tanh(100) Precision
- **Status**: Unverified
- **Impact**: Metal's `tanh()` may return `1.0` exactly for large inputs where other backends return `0.99999...`
- **Workaround**: None yet - may need explicit clamping or soft-saturation

### 4. ~~Texture Sampling Tests~~ ✅ RESOLVED
- **Status**: Working
- Implemented texture and sampler binding in `metal-gpu-harness.mm`
- Added TypeScript marshalling with binding indices in `metal-backend.ts`
- **Test**: `18-texture-sampling-modes.test.ts` - 2/2 pass

---
*Last updated: 2026-02-07*
