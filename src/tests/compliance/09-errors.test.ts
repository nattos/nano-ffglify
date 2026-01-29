import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Error Handling & Negative Tests', () => {

  const runBadIR = (name: string, nodes: any[], resources: any[] = []) => {
    // If we want these to pass eventually, we need to assert failure.
    // For "penciling in", we can write them as standard tests asserting .toThrow().
    // If they fail now (because they don't throw), that's the "Red" state we want.
    it(name, () => {
      const ir: IRDocument = {
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
          edges: []
        }]
      };

      const ctx = new EvaluationContext(ir, new Map());
      const exec = new CpuExecutor(ctx);

      expect(() => {
        exec.executeEntry();
      }).toThrow();
    });
  };

  // ----------------------------------------------------------------
  // Type Safety
  // ----------------------------------------------------------------
  describe('Type Validation', () => {
    // Math ops should fail when given Vectors if they are Scalar-only (unless we upgrade them)
    // Current `math_add` might behave weirdly.
    runBadIR('Math op (scalar) with Vector input', [
      { id: 'v1', op: 'vec3', x: 1, y: 2, z: 3 },
      { id: 'v2', op: 'vec3', x: 4, y: 5, z: 6 },
      { id: 'bad_add', op: 'math_add', a: 'v1', b: 'v2' }
    ]);

    runBadIR('Dot Product with mismatched lengths', [
      { id: 'v2', op: 'vec2', x: 1, y: 2 },
      { id: 'v3', op: 'vec3', x: 1, y: 2, z: 3 },
      { id: 'bad_dot', op: 'vec_dot', a: 'v2', b: 'v3' }
    ]);

    // Mat Mul Mismatch
    runBadIR('Matrix Multiplication Mismatch (Mat4 x Vec3)', [
      { id: 'm4', op: 'mat_identity', size: 4 },
      { id: 'v3', op: 'vec3', x: 1, y: 2, z: 3 },
      { id: 'bad_mul', op: 'mat_mul', a: 'm4', b: 'v3' }
    ]);
  });

  // ----------------------------------------------------------------
  // Resource Access
  // ----------------------------------------------------------------
  describe('Resource Validation', () => {
    runBadIR('Access Non-Existent Resource', [
      { id: 'bad_load', op: 'buffer_load', buffer: 'missing_id', index: 0 }
    ]);

    runBadIR('Resize Texture with Invalid Format Constant', [
      { id: 'bad_resize', op: 'cmd_resize_resource', resource: 'tex', size: [10, 10], format: 99999 }
    ], [{ id: 'tex', type: 'texture2d', size: { mode: 'fixed', value: [1, 1] } }]);
  });

  // ----------------------------------------------------------------
  // Argument Validation
  // ----------------------------------------------------------------
  describe('Argument Validation', () => {
    runBadIR('Missing Required Argument', [
      { id: 'c1', op: 'const_get', name: 'TextureFormat.RGBA8' },
      // math_add requires a and b. Missing b.
      { id: 'bad_op', op: 'math_add', a: 'c1' }
    ]);

    runBadIR('Invalid Argument Type (String for Math)', [
      { id: 's1', op: 'var_get', var: 'some_string' }, // Assume defined elsewhere or just literal "foo" if we had string op?
      // Hack: force string into system via const? Or var?
      // Let's use a struct or just assume strict type checking on literal args if we supported them in IR?
      // IR args are values or node IDs.
      // Let's rely on runtime context var.
      { id: 'set_str', op: 'var_set', var: 's', val: "not_a_number" },
      { id: 'bad_math', op: 'math_add', a: 'set_str', b: 10 }
    ]);

    runBadIR('Const Get Invalid Name', [
      { id: 'bad_const', op: 'const_get', name: 'NON_EXISTENT_CONSTANT' }
    ]);
  });

  // ----------------------------------------------------------------
  // Structure & Resource Logic
  // ----------------------------------------------------------------
  describe('Structure & Logic Validation', () => {
    runBadIR('Struct Extract from Non-Struct', [
      { id: 'scalar', op: 'vec2', x: 1, y: 2 }, // Vector is Array, not Struct
      { id: 'bad_extract', op: 'struct_extract', struct: 'scalar', key: 'x' }
    ]);

    runBadIR('Buffer Store Negative Index', [
      { id: 'bad_store', op: 'buffer_store', buffer: 'buf', index: -1, value: 10 }
    ], [{ id: 'buf', type: 'buffer', size: { mode: 'fixed', value: 10 }, persistence: { retain: false } }]);
  });

  // ----------------------------------------------------------------
  // Function Call Safety
  // ----------------------------------------------------------------
  describe('Function Safety', () => {
    // IR definition: fn_target inputs: ['a']. Call without 'a'.
    // Note: We need to define fn_target in the IR.
    // runBadIR helper builds a single fn_main. We need a way to add another function.
    // We'll skip complex multi-function invalid calls for this simple helper for now,
    // or manually verify locally.
    // Let's stick to single-function errors or simple recursion (already added).
  });

  // ----------------------------------------------------------------
  // Control Flow
  // ----------------------------------------------------------------
  describe('Control Flow', () => {
    runBadIR('Infinite Loop (Timeout Check)', [
      // while(true) {}
      // Requires flow loops which are mock-implemented in ops but handled in executor
      // We'll simulate a loop node structure directly?
      // Actually `flow_loop` op is just a marker.
      // Let's rely on max iteration limits (if we implement them).
      // For now, this is a placeholder.
      { id: 'loop', op: 'flow_loop', start: 0, end: 1000000 }
    ]);

    runBadIR('Recursion Limit', [
      { id: 'recurse', op: 'call_func', func: 'fn_main' }
    ]);
  });

});
