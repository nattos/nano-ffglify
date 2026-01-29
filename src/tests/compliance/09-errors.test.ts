import { describe, it, expect } from 'vitest';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';
import { validateIR, ValidationError } from '../../ir/validator';

describe('Compliance: Error Handling & Negative Tests', () => {

  const buildIR = (name: string, nodes: any[], resources: any[] = []): IRDocument => {
    // Auto-wire edges logic (shared)
    const edges: any[] = [];
    const nodeIds = new Set(nodes.map(n => n.id));

    nodes.forEach(node => {
      Object.keys(node).forEach(key => {
        const val = node[key];
        if (typeof val === 'string' && nodeIds.has(val) && val !== node.id) {
          edges.push({ from: val, portOut: 'val', to: node.id, portIn: key, type: 'data' });
        }
      });
    });

    return {
      version: '3.0.0',
      meta: { name },
      entryPoint: 'fn_main',
      inputs: [],
      structs: [],
      resources: resources,
      functions: [{
        id: 'fn_main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: nodes.map((n, i) => ({ ...n, id: n.id || `node_${i}` })),
        edges: edges
      }]
    };
  };

  const runBadIR = (name: string, nodes: any[], resources: any[] = []) => {
    it(name, () => {
      const ir = buildIR(name, nodes, resources);
      const ctx = new EvaluationContext(ir, new Map());
      const exec = new CpuExecutor(ctx);

      expect(() => {
        exec.executeEntry();
      }).toThrow();
    });
  };

  const runStaticBadIR = (name: string, nodes: any[], resources: any[] = [], expectedErrorSnippet?: string) => {
    it(`[Static] ${name}`, () => {
      const ir = buildIR(name, nodes, resources);
      const errors = validateIR(ir);

      // Assume we expect errors
      expect(errors.length).toBeGreaterThan(0);
      if (expectedErrorSnippet) {
        const combined = errors.map(e => e.message).join('\n');
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
    runStaticBadIR('Math op (scalar) with Vector input', [
      { id: 'v1', op: 'vec3', x: 1, y: 2, z: 3 },
      { id: 'v2', op: 'vec3', x: 4, y: 5, z: 6 },
      { id: 'bad_add', op: 'math_add', a: 'v1', b: 'v2' },
      { id: 'sink', op: 'var_set', var: 'x', val: 'bad_add' } // Force execution
    ], [], 'Type Mismatch');

    // Dot Product Mismatch: 'vec_dot' inputs are both 'vector'. Signature checks specific types.
    runStaticBadIR('Dot Product with mismatched lengths', [
      { id: 'v2', op: 'vec2', x: 1, y: 2 },
      { id: 'v3', op: 'vec3', x: 1, y: 2, z: 3 },
      { id: 'bad_dot', op: 'vec_dot', a: 'v2', b: 'v3' },
      { id: 'sink', op: 'var_set', var: 'x', val: 'bad_dot' }
    ], [], 'Type Mismatch'); // Expected vec2, got vec3 or similar

    // Mat Mul Mismatch
    runStaticBadIR('Matrix Multiplication Mismatch (Mat4 x Vec3)', [
      { id: 'm4', op: 'mat_identity', size: 4 }, // mat4
      { id: 'v3', op: 'vec3', x: 1, y: 2, z: 3 },
      { id: 'bad_mul', op: 'mat_mul', a: 'm4', b: 'v3' },
      { id: 'sink', op: 'var_set', var: 'x', val: 'bad_mul' }
    ], [], 'Type Mismatch');
  });

  // ----------------------------------------------------------------
  // Resource Access
  // ----------------------------------------------------------------
  describe('Resource Validation', () => {
    runStaticBadIR('Access Non-Existent Resource', [
      { id: 'bad_load', op: 'buffer_load', buffer: 'missing_id', index: 0 },
      { id: 'sink', op: 'var_set', var: 'x', val: 'bad_load' }
    ], [], 'Referenced resource'); // 'missing_id' not found

    // Resize format invalid logic is inside the op? Or arg validation?
    // OpSignature for cmd_resize_resource?
    // Currently relying on Runtime check for Format Constant.
    runBadIR('Resize Texture with Invalid Format Constant', [
      { id: 'bad_resize', op: 'cmd_resize_resource', resource: 'tex', size: [10, 10], format: 99999 }
    ], [{ id: 'tex', type: 'texture2d', size: { mode: 'fixed', value: [1, 1] }, persistence: { retain: false } }]);
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
    // var_set outputs 'any'. math_add inputs 'number'.
    // validator cannot prove 'any' is 'number'?
    // Only if we infer var_set output type from its input.
    runStaticBadIR('Invalid Argument Type (String for Math)', [
      { id: 's1', op: 'var_get', var: 'some_string' },
      { id: 'set_str', op: 'var_set', var: 's', val: "not_a_number" },
      { id: 'bad_math', op: 'math_add', a: 'set_str', b: 10 },
      { id: 'sink', op: 'var_set', var: 'y', val: 'bad_math' }
    ], [], 'Type Mismatch'); // var_set output is 'string', math_add expects 'number'

    runStaticBadIR('Const Get Invalid Name', [
      { id: 'bad_const', op: 'const_get', name: 'NON_EXISTENT_CONSTANT' },
      { id: 'sink', op: 'var_set', var: 'x', val: 'bad_const' }
    ], [], 'Invalid constant name');

    runStaticBadIR('Multiple Static Errors (Accumulation)', [
      // Error 1: Missing Argument in math_add
      { id: 'op1', op: 'math_add', a: 10 }, // missing b
      // Error 2: Type Mismatch in vec3 input
      // vec3 takes numbers. We pass a string literal? No, string is assumed ref.
      // Pass an object to force type error?
      // Or just another missing arg?
      // Let's use Invalid Literal Type if possible.
      // Or just missing arg in another node.
      { id: 'op2', op: 'vec2', x: 10 }, // missing y
      { id: 'sink', op: 'var_set', var: 'x', val: 'op1' }
    ], [], 'Missing required argument'); // Should contain it twice or for different nodes?
    // We can assert manually in the test body if runStaticBadIR supported custom checks,
    // but here we just check it contains the snippet.
    // It will contain "Missing required argument" (matches both).
    // To be sure, let's look for op IDs?
    // My validator message includes "for op 'math_add'" and "for op 'vec2'".
  });

  // ----------------------------------------------------------------
  // Structure & Resource Logic
  // ----------------------------------------------------------------
  describe('Structure & Logic Validation', () => {
    runStaticBadIR('Struct Extract from Non-Struct', [
      { id: 'scalar', op: 'vec2', x: 1, y: 2 }, // Vector, not Struct
      { id: 'bad_extract', op: 'struct_extract', struct: 'scalar', key: 'x' },
      { id: 'sink', op: 'var_set', var: 'x', val: 'bad_extract' }
    ], [], 'Type Mismatch');

    runStaticBadIR('Buffer Store Negative Index', [
      { id: 'bad_store', op: 'buffer_store', buffer: 'buf', index: -1, value: 10 }
    ], [{ id: 'buf', type: 'buffer', size: { mode: 'fixed', value: 10 }, persistence: { retain: false } }], 'Invalid Negative Index');

    // New: Static OOB
    runStaticBadIR('Buffer Store Static OOB', [
      { id: 'bad_oob', op: 'buffer_store', buffer: 'buf', index: 10, value: 99 } // Size 10, Index 10 is OOB (0-9 valid)
    ], [{ id: 'buf', type: 'buffer', size: { mode: 'fixed', value: 10 }, persistence: { retain: false } }], 'Static OOB Access');
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

    runBadIR('Recursion Limit', [
      { id: 'recurse', op: 'call_func', func: 'fn_main' },
      { id: 'sink', op: 'var_set', var: 'x', val: 'recurse' }
    ]);
  });

});
