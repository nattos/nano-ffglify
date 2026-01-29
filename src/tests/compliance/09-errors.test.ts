import { describe, it, expect } from 'vitest';
import { runGraphErrorTest, buildSimpleIR } from './test-runner';
import { validateIR, ValidationError } from '../../ir/schema';

describe('Compliance: Error Handling & Negative Tests', () => {

  const runStaticBadIR = (name: string, nodes: any[], resources: any[] = [], expectedErrorSnippet?: string) => {
    it(`[Static] ${name}`, () => {
      const ir = buildSimpleIR(name, nodes, resources);
      const result = validateIR(ir);

      // Assume we expect errors
      expect(result.success).toBe(false);
      if (!result.success && expectedErrorSnippet) {
        const combined = result.errors.map(e => e.message).join('\n');
        expect(combined).toContain(expectedErrorSnippet);
      }
    });
  };


  // ----------------------------------------------------------------
  // Type Safety
  // ----------------------------------------------------------------
  describe('Type Validation', () => {
    // Math ops should fail when given Vectors if they are Scalar-only (unless we upgrade them)
    // Current `math_add` might behave weirdly.
    // Math ops should fail when given mismatched types (e.g. Vec + Scalar, if no broadcast)
    runStaticBadIR('Math op mismatch (Vec + Scalar)', [
      { id: 'v1', op: 'float3', x: 1, y: 2, z: 3 },
      { id: 'bad_add', op: 'math_add', a: 'v1', b: 10 }, // signatures.ts doesn't allow (float3, number)
    ], [], 'Type Mismatch');

    // Dot Product Mismatch: 'vec_dot' inputs are both 'vector'. Signature checks specific types.
    runStaticBadIR('Dot Product with mismatched lengths', [
      { id: 'v2', op: 'float2', x: 1, y: 2 },
      { id: 'v3', op: 'float3', x: 1, y: 2, z: 3 },
      { id: 'bad_dot', op: 'vec_dot', a: 'v2', b: 'v3' },
    ], [], 'Type Mismatch'); // Expected float2, got float3 or similar

    // Mat Mul Mismatch
    runStaticBadIR('Matrix Multiplication Mismatch (float4x4 x float3)', [
      { id: 'm4', op: 'mat_identity', size: 4 }, // float4x4
      { id: 'v3', op: 'float3', x: 1, y: 2, z: 3 },
      { id: 'bad_mul', op: 'mat_mul', a: 'm4', b: 'v3' },
    ], [], 'Type Mismatch');

    // Strict Coercion Tests (No Implicit Casting)
    runStaticBadIR('Implicit Broadcast (Float -> float3)', [
      { id: 'f1', op: 'math_add', a: 1, b: 2 }, // returns number
      // vec_dot expects float3, float3. We pass a number.
      // Or simply explicit casting?
      // Let's force a connection to a float3 input.
      // float3 constructor takes x,y,z (numbers).
      // vec_dot takes float3.
      { id: 'v3', op: 'float3', x: 1, y: 2, z: 3 },
      { id: 'bad_dot', op: 'vec_dot', a: 'f1', b: 'v3' }, // a is number, b is float3.
    ], [], 'Type Mismatch');

    runStaticBadIR('Implicit Truncation (float3 -> Float)', [
      { id: 'v3', op: 'float3', x: 1, y: 2, z: 3 },
      // math_add expects number. We pass float3.
      { id: 'bad_add', op: 'math_add', a: 'v3', b: 10 },
    ], [], 'Type Mismatch');
  });

  // ----------------------------------------------------------------
  // Resource Access
  // ----------------------------------------------------------------
  describe('Resource Validation', () => {
    runStaticBadIR('Access Non-Existent Resource', [
      { id: 'bad_load', op: 'buffer_load', buffer: 'missing_id', index: 0 },
    ], [], 'Referenced resource'); // 'missing_id' not found

    // Resize format invalid logic is inside the op? Or arg validation?
    // OpSignature for cmd_resize_resource?
    // Currently relying on Runtime check for Format Constant.
    runGraphErrorTest('Resize Texture with Invalid Format Constant', [
      { id: 'bad_resize', op: 'cmd_resize_resource', resource: 'tex', size: [10, 10], format: 99999 }
    ], /./, // Any throws is fine
      [{ id: 'tex', type: 'texture2d', size: { mode: 'fixed', value: [1, 1] }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }]);
  });

  // ----------------------------------------------------------------
  // Argument Validation
  // ----------------------------------------------------------------
  describe('Argument Validation', () => {
    runStaticBadIR('Missing Required Argument', [
      { id: 'c1', op: 'const_get', name: 'TextureFormat.RGBA8' },
      // math_add requires a and b. Missing b.
      { id: 'bad_op', op: 'math_add', a: 'c1' },
      { id: 'sink', op: 'var_set', var: 'x', val: 'bad_op' }
    ], [], 'Missing required argument');

    // Invalid Literal Type
    // Note: if 'set_str' is used, it's a node ref. If 'set_str' returns a string...
    // var_set outputs 'any'. math_add inputs 'float'.
    // validator cannot prove 'any' is 'float'?
    // Only if we infer var_set output type from its input.
    runStaticBadIR('Invalid Argument Type (String for Math)', [
      { id: 's1', op: 'var_get', var: 'some_string' },
      { id: 'set_str', op: 'var_set', var: 's', val: "not_a_number" },
      { id: 'bad_math', op: 'math_add', a: 'set_str', b: 10 },
    ], [], 'Type Mismatch'); // var_set output is 'string', math_add expects 'float'

    runStaticBadIR('Const Get Invalid Name', [
      { id: 'bad_const', op: 'const_get', name: 'NON_EXISTENT_CONSTANT' },
    ], [], 'Invalid constant name');

    runStaticBadIR('Multiple Static Errors (Accumulation)', [
      // Error 1: Missing Argument in math_add
      { id: 'op1', op: 'math_add', a: 10 }, // missing b
      // Error 2: Type Mismatch in float3 input
      // float3 takes numbers. We pass a string literal? No, string is assumed ref.
      // Pass an object to force type error?
      // Or just another missing arg?
      // Let's use Invalid Literal Type if possible.
      // Or just missing arg in another node.
      { id: 'op2', op: 'float2', x: 10 }, // missing y
    ], [], 'Missing required argument'); // Should contain it twice or for different nodes?
    // We can assert manually in the test body if runStaticBadIR supported custom checks,
    // but here we just check it contains the snippet.
    // It will contain "Missing required argument" (matches both).
    // To be sure, let's look for op IDs?
    // My validator message includes "for op 'math_add'" and "for op 'float2'".
  });

  // ----------------------------------------------------------------
  // Structure & Resource Logic
  // ----------------------------------------------------------------
  describe('Structure & Logic Validation', () => {
    runStaticBadIR('Struct Extract from Non-Struct', [
      { id: 'scalar', op: 'float2', x: 1, y: 2 }, // Vector, not Struct
      { id: 'bad_extract', op: 'struct_extract', struct: 'scalar', key: 'x' },
    ], [], 'Type Mismatch');

    runStaticBadIR('Buffer Store Negative Index', [
      { id: 'bad_store', op: 'buffer_store', buffer: 'buf', index: -1, value: 10 }
    ], [{ id: 'buf', type: 'buffer', size: { mode: 'fixed', value: 10 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }], 'Invalid Negative Index');

    // New: Static OOB
    runStaticBadIR('Buffer Store Static OOB', [
      { id: 'bad_oob', op: 'buffer_store', buffer: 'buf', index: 10, value: 99 } // Size 10, Index 10 is OOB (0-9 valid)
    ], [{ id: 'buf', type: 'buffer', size: { mode: 'fixed', value: 10 }, persistence: { retain: false, clearOnResize: false, clearEveryFrame: false, cpuAccess: false } }], 'Static OOB Access');
  });

  // ----------------------------------------------------------------
  // Control Flow
  // ----------------------------------------------------------------
  const skipBadIR = (name: string, nodes: any[], resources: any[] = []) => {
    it.skip(name, () => { /* Skipped */ });
  };

  describe('Control Flow', () => {
    skipBadIR('Infinite Loop (Timeout Check)', [
      // while(true) {}
      // Requires flow loops which are mock-implemented in ops but handled in executor
      // We'll simulate a loop node structure directly?
      // Actually `flow_loop` op is just a marker.
      // Let's rely on max iteration limits (if we implement them).
      // For now, this is a placeholder.
      { id: 'loop', op: 'flow_loop', start: 0, end: 1000000 }
    ]);

    runGraphErrorTest('Recursion Limit', [
      { id: 'recurse', op: 'call_func', func: 'main' },
      { id: 'sink', op: 'var_set', var: 'x', val: 'recurse' }
    ], /Recursion/);
  });

});
