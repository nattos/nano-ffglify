import { describe, it, expect } from 'vitest';
import { validateIR } from './schema';
import { IRDocument } from './types';
import { reconstructEdges } from './utils';

describe('Regression: Refable Arguments', () => {
  it('should allow refable dispatch size in cmd_dispatch', () => {
    const doc: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Dispatch Ref Test' },
      entryPoint: 'fn_main',
      inputs: [
        { id: 'u_size', type: 'int', default: 16 }
      ],
      resources: [],
      structs: [],
      functions: [
        {
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'n1', op: 'cmd_dispatch', func: 'fn_compute', dispatch: ['u_size', 1, 1] }
          ]
        },
        {
          id: 'fn_compute',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: []
        }
      ]
    };

    const result = validateIR(doc);
    if (!result.success) {
      console.log(JSON.stringify(result.errors, null, 2));
    }
    expect(result.success).toBe(true);

    // Also verify edges are reconstructed correctly
    const edges = reconstructEdges(doc.functions[0], doc);
    const dispatchEdge = edges.find(e => e.to === 'n1' && e.portIn === 'dispatch[0]');
    expect(dispatchEdge).toBeDefined();
    expect(dispatchEdge?.from).toBe('u_size');
  });

  it('should detect missing refs in cmd_dispatch array', () => {
    const doc: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Dispatch Missing Ref Test' },
      entryPoint: 'fn_main',
      inputs: [],
      resources: [],
      structs: [],
      functions: [
        {
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'n1', op: 'cmd_dispatch', func: 'fn_compute', dispatch: ['u_missing', 1, 1] }
          ]
        },
        { id: 'fn_compute', type: 'shader', inputs: [], outputs: [], localVars: [], nodes: [] }
      ]
    };

    const result = validateIR(doc);
    expect(result.success).toBe(false);

    // Check for specific error message
    const error = (result as any).errors.find((e: any) => e.message.includes("references unknown ID 'u_missing'"));
    expect(error).toBeDefined();
  });

  it('should allow refable count in cmd_draw', () => {
    const doc: IRDocument = {
      version: '3.0.0',
      meta: { name: 'Draw Ref Test' },
      entryPoint: 'fn_main',
      inputs: [
        { id: 'u_count', type: 'int', default: 100 }
      ],
      resources: [
        {
          id: 't_out',
          type: 'texture2d',
          format: 'rgba8' as any,
          size: { mode: 'fixed', value: [256, 256] },
          persistence: { retain: false, clearOnResize: false, clearEveryFrame: true, cpuAccess: false }
        }
      ],
      structs: [],
      functions: [
        {
          id: 'fn_main',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'n1', op: 'cmd_draw', target: 't_out', vertex: 'fn_v', fragment: 'fn_f', count: 'u_count' }
          ]
        },
        { id: 'fn_v', type: 'shader', inputs: [], outputs: [], localVars: [], nodes: [] },
        { id: 'fn_f', type: 'shader', inputs: [], outputs: [], localVars: [], nodes: [] }
      ]
    };

    const result = validateIR(doc);
    if (!result.success) {
      console.log(JSON.stringify(result.errors, null, 2));
    }
    expect(result.success).toBe(true);

    const edges = reconstructEdges(doc.functions[0], doc);
    const countEdge = edges.find(e => e.to === 'n1' && e.portIn === 'count');
    expect(countEdge).toBeDefined();
    expect(countEdge?.from).toBe('u_count');
  });
});
