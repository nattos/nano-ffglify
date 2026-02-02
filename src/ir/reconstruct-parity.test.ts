import { describe, it, expect } from 'vitest';
import { reconstructEdges } from './utils';
import { FunctionDef, Edge } from './types';

describe('Edge Reconstruction Parity', () => {

  const verifyParity = (name: string, func: FunctionDef, expectedEdges: Edge[]) => {
    it(name, () => {
      const reconstructed = reconstructEdges(func);

      // Sort for comparison
      const sortEdges = (edges: Edge[]) => [...edges].sort((a, b) => {
        const keyA = `${a.from}:${a.portOut}:${a.to}:${a.portIn}:${a.type}`;
        const keyB = `${b.from}:${b.portOut}:${b.to}:${b.portIn}:${b.type}`;
        return keyA.localeCompare(keyB);
      });

      expect(sortEdges(reconstructed)).toEqual(sortEdges(expectedEdges));
    });
  };

  // 1. Scalar Math (Pure)
  verifyParity('should reconstruct math_add edges', {
    id: 'fn',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'n1', op: 'math_add', a: 1, b: 2 },
      { id: 'n2', op: 'math_add', a: 'n1', b: 5 }
    ]
  }, [
    { from: 'n1', portOut: 'val', to: 'n2', portIn: 'a', type: 'data' }
  ]);

  // 2. Struct Construction
  verifyParity('should reconstruct struct_construct edges', {
    id: 'fn',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'p1', op: 'math_add', a: 0, b: 0 },
      { id: 's1', op: 'struct_construct', type: 'Point', x: 'p1', y: 10 }
    ]
  }, [
    { from: 'p1', portOut: 'val', to: 's1', portIn: 'x', type: 'data' }
  ]);

  // 3. Array Construction (Indexed Ports)
  verifyParity('should reconstruct array_construct edges with indexed ports', {
    id: 'fn',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'v0', op: 'float', val: 1 },
      { id: 'v1', op: 'float', val: 2 },
      { id: 'arr', op: 'array_construct', values: ['v0', 'v1'] }
    ]
  }, [
    { from: 'v0', portOut: 'val', to: 'arr', portIn: 'values[0]', type: 'data' },
    { from: 'v1', portOut: 'val', to: 'arr', portIn: 'values[1]', type: 'data' }
  ]);

  // 4. Execution Flow (Simple)
  verifyParity('should reconstruct simple execution flow', {
    id: 'fn',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'set1', op: 'var_set', var: 'x', val: 10 },
      { id: 'set2', op: 'var_set', var: 'y', val: 20, exec_in: 'set1' }
    ]
  }, [
    { from: 'set1', portOut: 'exec_out', to: 'set2', portIn: 'exec_in', type: 'execution' }
  ]);

  // 5. Control Flow (Branching)
  verifyParity('should reconstruct branch execution flow', {
    id: 'fn',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'cond', op: 'math_gt', a: 1, b: 0 },
      { id: 'br', op: 'flow_branch', cond: 'cond', exec_true: 't1', exec_false: 'f1' },
      { id: 't1', op: 'var_set', var: 'res', val: 1 },
      { id: 'f1', op: 'var_set', var: 'res', val: 0 }
    ]
  }, [
    { from: 'cond', portOut: 'val', to: 'br', portIn: 'cond', type: 'data' },
    { from: 'br', portOut: 'exec_true', to: 't1', portIn: 'exec_in', type: 'execution' },
    { from: 'br', portOut: 'exec_false', to: 'f1', portIn: 'exec_in', type: 'execution' }
  ]);

  // 6. Function Calls
  verifyParity('should reconstruct call_func edges', {
    id: 'fn',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'arg1', op: 'float', val: 5 },
      { id: 'c1', op: 'call_func', func: 'some_fn', arg_x: 'arg1' }
    ]
  }, [
    { from: 'arg1', portOut: 'val', to: 'c1', portIn: 'arg_x', type: 'data' }
  ]);

  // 7. Loop Flow
  // 8. Integration: Precomputed Blur Pipeline
  verifyParity('should reconstruct Blur CPU Orchestrator edges', {
    id: 'fn_main_cpu',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'resize_w', op: 'cmd_resize_resource', resource: 'b_weights', size: 'u_kernel_size' },
      { id: 'cmd_gen', op: 'cmd_dispatch', func: 'fn_gen_kernel', dispatch: [4, 1, 1], exec_in: 'resize_w' },
      { id: 'cmd_blur', op: 'cmd_dispatch', func: 'fn_blur', dispatch: [1, 1, 1], exec_in: 'cmd_gen' }
    ]
  }, [
    { from: 'resize_w', portOut: 'exec_out', to: 'cmd_gen', portIn: 'exec_in', type: 'execution' },
    { from: 'cmd_gen', portOut: 'exec_out', to: 'cmd_blur', portIn: 'exec_in', type: 'execution' }
  ]);

  verifyParity('should reconstruct Blur Shader (fn_gen_kernel) edges', {
    id: 'fn_gen_kernel',
    type: 'shader',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'th_id', op: 'builtin_get', name: 'global_invocation_id' },
      { id: 'idx', op: 'vec_get_element', vec: 'th_id', index: 0 },
      { id: 'val', op: 'math_mul', a: 'idx', b: 10 },
      { id: 'store', op: 'buffer_store', buffer: 'b_weights', index: 'idx', value: 'val' }
    ]
  }, [
    { from: 'th_id', portOut: 'val', to: 'idx', portIn: 'vec', type: 'data' },
    { from: 'idx', portOut: 'val', to: 'val', portIn: 'a', type: 'data' },
    { from: 'idx', portOut: 'val', to: 'store', portIn: 'index', type: 'data' },
    { from: 'val', portOut: 'val', to: 'store', portIn: 'value', type: 'data' }
  ]);

  // 10. Pure Node as Execution Dependency (Should be ignored for execution flow)
  verifyParity('should ignore execution edges from pure nodes', {
    id: 'fn',
    type: 'cpu',
    inputs: [],
    outputs: [],
    localVars: [],
    nodes: [
      { id: 'pure', op: 'math_add', a: 1, b: 2 },
      { id: 'exec', op: 'var_set', var: 'x', val: 'pure', exec_in: 'pure' }
    ]
  }, [
    { from: 'pure', portOut: 'val', to: 'exec', portIn: 'val', type: 'data' }
    // No execution edge from 'pure' to 'exec' because 'pure' is not executable
  ]);

});
