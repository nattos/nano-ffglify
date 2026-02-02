import { describe, it, expect } from 'vitest';
import { analyzeFunction, analyzeGlobals } from './analyzer';
import { IRDocument } from './types';

describe('IR Analyzer', () => {
  const mockDoc: IRDocument = {
    version: '3.0.0',
    meta: { name: 'Test' },
    entryPoint: 'fn_main',
    inputs: [
      { id: 'u_global', type: 'float', default: 1.0 }
    ],
    resources: [
      { id: 't_tex', type: 'texture2d', format: 'rgba8' as any, size: { mode: 'fixed', value: [256, 256] }, persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: false } }
    ],
    structs: [],
    functions: [
      {
        id: 'fn_main',
        type: 'cpu',
        inputs: [{ id: 'param1', type: 'int' }],
        outputs: [],
        localVars: [{ id: 'v_local', type: 'float', initialValue: 0.5 }],
        nodes: [
          { id: 'n1', op: 'math_add', a: 'param1', b: 10 },
          { id: 'n2', op: 'var_set', var: 'v_local', val: 'n1' },
          { id: 'loop', op: 'flow_loop', start: 0, end: 'param1', exec_body: 'n3' },
          { id: 'n3', op: 'math_mul', a: 'v_local', b: 2, exec_in: 'loop' },
          { id: 'n4', op: 'texture_store', tex: 't_tex', coords: [0, 0], value: [1, 0, 0, 1], exec_in: 'n3' }
        ]
      }
    ]
  };

  it('should analyze a function header correctly', () => {
    const result = analyzeFunction(mockDoc.functions[0], mockDoc);
    const headerLine = result.lines[0];

    expect(headerLine.parts.some(p => p.type === 'keyword' && p.text === 'fn')).toBe(true);
    expect(headerLine.parts.some(p => p.type === 'ref' && p.text === 'fn_main' && p.refId === 'global:fn_main')).toBe(true);
    expect(headerLine.parts.some(p => p.type === 'ref' && p.text === 'param1' && p.dataType === 'int' && p.refId === 'fn_main:param1')).toBe(true);
  });

  it('should analyze local variables correctly', () => {
    const result = analyzeFunction(mockDoc.functions[0], mockDoc);
    const localVarLine = result.lines.find(l => l.parts.some(p => p.text === 'v_local'));

    expect(localVarLine).toBeDefined();
    expect(localVarLine?.parts.some(p => p.type === 'keyword' && p.text === 'var')).toBe(true);
    expect(localVarLine?.parts.some(p => p.type === 'type' && p.text === 'float')).toBe(true);
    expect(localVarLine?.parts.some(p => p.type === 'literal' && p.text === '0.5')).toBe(true);
    expect(localVarLine?.parts.some(p => p.type === 'ref' && p.text === 'v_local' && p.refId === 'fn_main:v_local')).toBe(true);
  });

  it('should detect references correctly', () => {
    const result = analyzeFunction(mockDoc.functions[0], mockDoc);

    // Check if 'param1' is referenced in 'n1'
    expect(result.refs.get('fn_main:param1')).toContain('n1');
    // Check if 'v_local' is referenced in 'n2' (as 'var') and 'n3' (as 'a')
    expect(result.refs.get('fn_main:v_local')).toContain('n2');
    expect(result.refs.get('fn_main:v_local')).toContain('n3');
    // Check if node 'n1' is referenced in 'n2'
    expect(result.refs.get('fn_main:n1')).toContain('n2');

    // Verify inline type for n1
    const n1Line = result.lines.find(l => l.nodeId === 'n1');
    expect(n1Line?.parts.some(p => p.type === 'type' && p.text === 'float')).toBe(true);
    expect(n1Line?.parts.some(p => p.text === ': ')).toBe(true);
  });

  it('should handle indentation for loops', () => {
    const result = analyzeFunction(mockDoc.functions[0], mockDoc);

    const loopLine = result.lines.find(l => l.nodeId === 'loop');
    const indentedLine = result.lines.find(l => l.nodeId === 'n3');

    expect(loopLine).toBeDefined();
    expect(indentedLine).toBeDefined();
    expect(indentedLine!.indent).toBe(loopLine!.indent + 1);
  });

  it('should identify global and resource references', () => {
    const result = analyzeFunction(mockDoc.functions[0], mockDoc);

    // Check if 't_tex' is referenced in 'n4'
    expect(result.refs.get('global:t_tex')).toContain('n4');
  });

  it('should analyze global inputs and resources correctly', () => {
    const lines = analyzeGlobals(mockDoc);

    // Check for u_global
    const inputLine = lines.find(l => l.parts.some(p => p.text === 'u_global'));
    expect(inputLine).toBeDefined();
    expect(inputLine?.parts.some(p => p.type === 'ref' && p.refId === 'global:u_global')).toBe(true);
    expect(inputLine?.parts.some(p => p.type === 'literal' && p.text === '1')).toBe(true);

    // Check for t_tex
    const resLine = lines.find(l => l.parts.some(p => p.text === 't_tex'));
    expect(resLine).toBeDefined();
    expect(resLine?.parts.some(p => p.type === 'keyword' && p.text === 'res')).toBe(true);
    expect(resLine?.parts.some(p => p.type === 'ref' && p.refId === 'global:t_tex')).toBe(true);
    expect(resLine?.parts.some(p => p.type === 'comment' && p.text.includes('format: rgba8'))).toBe(true);
    expect(resLine?.parts.some(p => p.type === 'comment' && p.text.includes('size: [256,256]'))).toBe(true);
  });
});
