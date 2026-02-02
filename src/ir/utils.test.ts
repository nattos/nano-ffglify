import { describe, it, expect } from 'vitest';
import { FunctionDef } from './types';
import { reconstructEdges } from './utils';

describe('reconstructEdges', () => {
  it('should reconstruct data edges from node properties', () => {
    const func: FunctionDef = {
      id: 'test_func',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'node_a', op: 'math_add', a: 10, b: 'node_b' },
        { id: 'node_b', op: 'math_mul', a: 5, b: 2 }
      ]
    };

    const edges = reconstructEdges(func);
    const dataEdges = edges.filter(e => e.type === 'data');

    expect(dataEdges).toHaveLength(1);
    expect(dataEdges[0]).toMatchObject({
      from: 'node_b',
      portOut: 'val',
      to: 'node_a',
      portIn: 'b',
      type: 'data'
    });
  });

  it('should reconstruct execution edges from exec_out', () => {
    const func: FunctionDef = {
      id: 'test_func',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'node_a', op: 'cmd_dispatch', func: 'other_func', exec_out: 'node_b' },
        { id: 'node_b', op: 'cmd_dispatch', func: 'final_func' }
      ]
    };

    const edges = reconstructEdges(func);
    const execEdges = edges.filter(e => e.type === 'execution');

    expect(execEdges).toHaveLength(1);
    expect(execEdges[0]).toMatchObject({
      from: 'node_a',
      portOut: 'exec_out',
      to: 'node_b',
      portIn: 'exec_in',
      type: 'execution'
    });
  });

  it('should reconstruct branching execution edges', () => {
    const func: FunctionDef = {
      id: 'test_func',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'branch', op: 'flow_branch', cond: true, exec_true: 'node_t', exec_false: 'node_f' },
        { id: 'node_t', op: 'cmd_dispatch', func: 't' },
        { id: 'node_f', op: 'cmd_dispatch', func: 'f' }
      ]
    };

    const edges = reconstructEdges(func);
    const execEdges = edges.filter(e => e.type === 'execution');

    expect(execEdges).toHaveLength(2);
    expect(execEdges).toContainEqual(expect.objectContaining({
      from: 'branch',
      portOut: 'exec_true',
      to: 'node_t',
      type: 'execution'
    }));
    expect(execEdges).toContainEqual(expect.objectContaining({
      from: 'branch',
      portOut: 'exec_false',
      to: 'node_f',
      type: 'execution'
    }));
  });

  it('should skip properties that are listed as NAME_PROPERTIES', () => {
    const func: FunctionDef = {
      id: 'test_func',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'node_a', op: 'var_get', var: 'node_b' }, // 'var' is a NAME_PROPERTY, should not create an edge
        { id: 'node_b', op: 'math_add', a: 1, b: 2 }
      ]
    };

    const edges = reconstructEdges(func);
    const dataEdges = edges.filter(e => e.type === 'data');

    expect(dataEdges).toHaveLength(1);
    expect(dataEdges[0]).toMatchObject({
      from: 'node_b',
      to: 'node_a',
      portIn: 'var',
      type: 'data'
    });
  });

  it('should handle complex mixed flow', () => {
    const func: FunctionDef = {
      id: 'test_func',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: [],
      nodes: [
        { id: 'start', op: 'cmd_dispatch', func: 'f1', exec_out: 'loop' },
        { id: 'loop', op: 'flow_loop', start: 0, end: 10, exec_body: 'body', exec_completed: 'end' },
        { id: 'body', op: 'var_set', var: 'x', val: 'calc' },
        { id: 'calc', op: 'math_add', a: 'idx_get', b: 1 },
        { id: 'idx_get', op: 'loop_index', loop: 'loop' },
        { id: 'end', op: 'cmd_dispatch', func: 'final' }
      ]
    };

    const edges = reconstructEdges(func);

    // Execution
    expect(edges).toContainEqual(expect.objectContaining({ from: 'start', to: 'loop', portOut: 'exec_out' }));
    expect(edges).toContainEqual(expect.objectContaining({ from: 'loop', to: 'body', portOut: 'exec_body' }));
    expect(edges).toContainEqual(expect.objectContaining({ from: 'loop', to: 'end', portOut: 'exec_completed' }));

    // Data
    expect(edges).toContainEqual(expect.objectContaining({ from: 'calc', to: 'body', portIn: 'val' }));
    expect(edges).toContainEqual(expect.objectContaining({ from: 'idx_get', to: 'calc', portIn: 'a' }));
  });
});
