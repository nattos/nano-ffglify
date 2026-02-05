import { describe, it, expect, beforeEach } from 'vitest';
import { ReplManager } from '../../runtime/repl-manager';
import { IRDocument } from '../../ir/types';

describe('ReplManager', () => {
  let replManager: ReplManager;

  beforeEach(() => {
    replManager = new ReplManager();
  });

  const validIR: IRDocument = {
    version: '1.0',
    meta: {
      name: 'Test IR',
    },
    entryPoint: 'main',
    functions: [
      {
        id: 'main',
        name: 'Main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        metadata: {},
        nodes: [
          { id: 'lit', op: 'float', val: 1.0 },
          { id: 'ret', op: 'func_return', val: 'lit' }
        ],
        edges: [
          { from: 'lit', portOut: 'val', to: 'ret', portIn: 'val', type: 'data' }
        ]
      }
    ],
    inputs: [],
    resources: [],
    structs: []
  };

  it('should compile a valid IR', async () => {
    const artifacts = await replManager.compile(validIR);
    if (!artifacts) {
      console.error('Validation Errors:', JSON.stringify(replManager.validationErrors, null, 2));
      console.error('Last Error:', replManager.lastError);
    }
    expect(artifacts).not.toBeNull();
    expect(artifacts?.ir).toBe(validIR);
    expect(artifacts?.compiled).toBeDefined();
    expect(replManager.lastError).toBeNull();
    expect(replManager.validationErrors).toHaveLength(0);
  });

  it('should fail compilation on invalid IR (validation error)', async () => {
    const invalidIR: IRDocument = {
      ...validIR,
      entryPoint: 'non-existent'
    };

    const artifacts = await replManager.compile(invalidIR);
    expect(artifacts).toBeNull();
    expect(replManager.lastError).toBe('Validation failed');
    expect(replManager.validationErrors.length).toBeGreaterThan(0);
  });

  it('should swap artifacts correctly', async () => {
    const artifacts = await replManager.compile(validIR);
    if (!artifacts) throw new Error('Compilation failed');

    replManager.swap(artifacts);
    expect(replManager.currentArtifacts?.ir.meta.name).toBe(validIR.meta.name);
  });
});
