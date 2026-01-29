import { describe, it, expect } from 'vitest';
import { EvaluationContext } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument } from '../../ir/types';

describe('Compliance: Vector Math Ops', () => {

  const buildIR = (name: string, nodes: any[]): IRDocument => {
    const edges: any[] = [];
    const nodeIds = new Set(nodes.map(n => n.id));
    nodes.forEach(node => {
      Object.keys(node).forEach(key => {
        const val = node[key];
        if (typeof val === 'string' && nodeIds.has(val) && val !== node.id) {
          // Ensure port match for binary ops (a, b) vs old (x, y) if any
          edges.push({ from: val, portOut: 'val', to: node.id, portIn: key, type: 'data' });
        }
      });
    });

    return {
      version: '1.0.0',
      meta: { name },
      entryPoint: 'main',
      inputs: [],
      resources: [],
      structs: [],
      functions: [{
        id: 'main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [{ id: 'res', type: 'any' }],
        nodes: nodes,
        edges: edges
      }]
    };
  };

  const runTest = (name: string, nodes: any[], varToCheck: string, expectedVal: any) => {
    it(name, () => {
      const ir = buildIR(name, nodes);
      const ctx = new EvaluationContext(ir, new Map());
      const exec = new CpuExecutor(ctx);

      // Manually execute
      ctx.pushFrame('test_main');
      const func = ir.functions[0];
      exec.executeFunction(func);

      const result = ctx.getVar(varToCheck);

      // Deep equal for vectors
      if (Array.isArray(expectedVal)) {
        expect(result).toEqual(expectedVal);
      } else {
        expect(result).toBeCloseTo(expectedVal as number, 5);
      }
    });
  };

  // ----------------------------------------------------------------
  // Vector Arithmetic
  // ----------------------------------------------------------------
  runTest('vec3_add', [
    { id: 'v1', op: 'vec3', x: 1, y: 2, z: 3 },
    { id: 'v2', op: 'vec3', x: 4, y: 5, z: 6 },
    { id: 'op', op: 'math_add', a: 'v1', b: 'v2' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [5, 7, 9]);

  runTest('vec2_mul', [
    { id: 'v1', op: 'vec2', x: 2, y: 3 },
    { id: 'v2', op: 'vec2', x: 4, y: 5 },
    { id: 'op', op: 'math_mul', a: 'v1', b: 'v2' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [8, 15]);

  // ----------------------------------------------------------------
  // Vector Logic (0.0 / 1.0)
  // ----------------------------------------------------------------
  runTest('vec3_gt (Mixed Result)', [
    { id: 'v1', op: 'vec3', x: 10, y: 2, z: 5 },
    { id: 'v2', op: 'vec3', x: 5, y: 2, z: 10 },
    // 10 > 5 -> 1.0
    // 2 > 2 -> 0.0
    // 5 > 10 -> 0.0
    { id: 'op', op: 'math_gt', a: 'v1', b: 'v2' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [1.0, 0.0, 0.0]);

  // ----------------------------------------------------------------
  // Vector Mix with Boolean-like Vector
  // ----------------------------------------------------------------
  runTest('vec_mix with vec_gt', [
    { id: 'red', op: 'vec3', x: 1, y: 0, z: 0 },
    { id: 'blue', op: 'vec3', x: 0, y: 0, z: 1 },

    // Condition: [1.0, 0.0, 0.0]
    { id: 'c_lhs', op: 'vec3', x: 10, y: 0, z: 0 },
    { id: 'c_rhs', op: 'vec3', x: 5, y: 5, z: 5 },
    { id: 'cond', op: 'math_gt', a: 'c_lhs', b: 'c_rhs' }, // [1, 0, 0]

    // mix(red, blue, cond)
    // idx 0: mix(1, 0, 1) -> 0 (Blue wins?) Wait. mix(a, b, t) = a(1-t) + b*t
    // t=1 -> b. t=0 -> a.
    // If we want "Select A if Cond", we usually use mix(b, a, cond).
    // Or standard: mix(edge0, edge1, t).
    // If Cond is 1 (True), we get edge1.
    // So mix(red, blue, 1) -> blue.
    // mix(red, blue, 0) -> red.
    // idx 0: t=1 -> blue.x (0)
    // idx 1: t=0 -> red.y (0)
    // idx 2: t=0 -> red.z (0)
    // Result: [0, 0, 0]?
    // Let's recheck logic.
    // red: [1, 0, 0]
    // blue: [0, 0, 1]
    // cond: [1, 0, 0]
    // i=0: 1*(1-1) + 0*(1) = 0.
    // i=1: 0*(1-0) + 0*(0) = 0.
    // i=2: 0*(1-0) + 1*(0) = 0.
    // Output: [0, 0, 0].

    // Let's try to select Red if True.
    // mix(blue, red, cond) -> t=1 -> red.
    { id: 'mix', op: 'vec_mix', a: 'blue', b: 'red', t: 'cond' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'mix' }
  ], 'res', [1, 0, 1]); // Red.x (1), Blue.y (0), Blue.z (1)

  // ----------------------------------------------------------------
  // Vector Clamp
  // ----------------------------------------------------------------
  runTest('vec3_clamp', [
    { id: 'val', op: 'vec3', x: -5, y: 5, z: 15 },
    { id: 'min', op: 'vec3', x: 0, y: 0, z: 0 },
    { id: 'max', op: 'vec3', x: 10, y: 10, z: 10 },
    { id: 'op', op: 'math_clamp', val: 'val', min: 'min', max: 'max' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'op' }
  ], 'res', [0, 5, 10]);

  // ----------------------------------------------------------------
  // Vector IsNan
  // ----------------------------------------------------------------
  runTest('vec2_is_nan', [
    { id: 'nan', op: 'math_sqrt', val: -1 }, // NaN
    { id: 'val', op: 'vec2', x: 10, y: 'nan' }, // [10, NaN] (Wait, vec2 ctor with string ref? manually link?)
    // Manual wiring needed for vec2 args if not literal.
    // My buildIR assumes literals.
    // I need to use 'vec2' node with inputs connected.
    // But 'vec2' has inputs x, y.
    // I need to define 'nan' node first.
    // v2 node: { id: 'v2', op: 'vec2', x: 10, y: 0 } -> no, can't mix const and input easily in buildIR unless I am clever.
    // buildIR connects matching IDs.
    // I can put 'nan' node ID into y field?
    // Type check for y is 'string'? 'nan' is string.
    // buildIR: if typeof val === 'string' ... edges.push

    // Correct setup:
    { id: 'nan_src', op: 'math_sqrt', val: -1 }, // Output is NaN
    { id: 'v_src', op: 'const_get', name: 'whatever' }, // Placeholder or just use literal 10 if allowed?
    // Ops allow literals... but 'vec2' inputs must be resolved.
    // Default validateArg allows literals.
    // So 'x': 10 is fine.
    // 'y': 'nan_src' (ID) -> buildIR creates edge.
    { id: 'vec', op: 'vec2', x: 10, y: 'nan_src' },

    { id: 'check', op: 'math_is_nan', val: 'vec' },
    { id: 'sink', op: 'var_set', var: 'res', val: 'check' }
  ], 'res', [0.0, 1.0]);

});
