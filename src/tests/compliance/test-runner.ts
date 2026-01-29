import { expect, it } from 'vitest';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { CpuExecutor } from '../../interpreter/executor';
import { IRDocument, FunctionDef } from '../../ir/types';

// ------------------------------------------------------------------
// Backend Abstraction
// ------------------------------------------------------------------
export interface TestBackend {
  name: string;
  createContext: (ir: IRDocument, inputs?: Map<string, RuntimeValue>) => Promise<EvaluationContext>;
  run: (ctx: EvaluationContext, entryPoint: string) => Promise<void>;
  execute: (ir: IRDocument, entryPoint: string, inputs?: Map<string, RuntimeValue>) => Promise<EvaluationContext>;
}

export const CpuBackend: TestBackend = {
  name: 'CPU Integration',
  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map()) => {
    return new EvaluationContext(ir, inputs);
  },
  run: async (ctx: EvaluationContext, entryPoint: string) => {
    const exec = new CpuExecutor(ctx);
    const func = ctx.ir.functions.find(f => f.id === entryPoint);
    if (!func) throw new Error(`Entry point '${entryPoint}' not found`);

    if (func.type === 'cpu') {
      ctx.pushFrame(entryPoint);
      exec.executeFunction(func);
    } else {
      ctx.pushFrame(entryPoint);
      exec.executeFunction(func);
    }
  },
  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await CpuBackend.createContext(ir, inputs);
    await CpuBackend.run(ctx, entryPoint);
    return ctx;
  }
};

export const availableBackends = [CpuBackend];

// ------------------------------------------------------------------
// Test Helpers
// ------------------------------------------------------------------

export const buildSimpleIR = (name: string, nodes: any[], resources: any[] = [], extraEdges: any[] = [], localVars: any[] = [{ id: 'res', type: 'any' }], structs: any[] = []): IRDocument => {
  const edges: any[] = [];
  const nodeIds = new Set(nodes.map(n => n.id));

  // Auto-wire 'data' edges based on matching IDs in properties
  nodes.forEach(node => {
    Object.keys(node).forEach(key => {
      // Skip properties that are structural references, not data edges
      if (['var', 'func', 'resource', 'buffer', 'tex', 'loop'].includes(key)) return;

      const val = node[key];
      if (typeof val === 'string' && nodeIds.has(val) && val !== node.id) {
        edges.push({ from: val, portOut: 'val', to: node.id, portIn: key, type: 'data' });
      }
    });
  });

  return {
    version: '1.0.0',
    meta: { name },
    entryPoint: 'main',
    inputs: [],
    resources: resources,
    structs: structs,
    functions: [{
      id: 'main',
      type: 'cpu',
      inputs: [],
      outputs: [],
      localVars: localVars,
      nodes: nodes,
      edges: [...edges, ...extraEdges]
    }]
  };
};

export const runGraphTest = (
  name: string,
  nodes: any[],
  varToCheck: string,
  expectedVal: any,
  backends: TestBackend[] = [CpuBackend]
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}]`, async () => {
      const ir = buildSimpleIR(name, nodes);
      const ctx = await backend.execute(ir, 'main');
      const result = ctx.getVar(varToCheck);

      if (Array.isArray(expectedVal)) {
        if (expectedVal.length > 0 && typeof expectedVal[0] === 'number') {
          // Element-wise closeTo for number arrays (vectors/matrices)
          const resArr = result as number[];
          expect(resArr).toHaveLength(expectedVal.length);
          resArr.forEach((val, idx) => {
            expect(val).toBeCloseTo(expectedVal[idx] as number, 5);
          });
        } else {
          expect(result).toEqual(expectedVal);
        }
      } else {
        if (Number.isNaN(expectedVal)) {
          expect(result).toBeNaN();
        } else {
          expect(result).toBeCloseTo(expectedVal as number, 5);
        }
      }
    });
  });
};

export const runGraphErrorTest = (
  name: string,
  nodes: any[],
  expectedError: string | RegExp,
  resources: any[] = [],
  structs: any[] = [],
  localVars: any[] = [{ id: 'res', type: 'any' }],
  backends: TestBackend[] = [CpuBackend]
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}] - Expect Error`, async () => {
      const ir = buildSimpleIR(name, nodes, resources, [], localVars, structs);
      try {
        await backend.execute(ir, 'main');
        expect.fail('Expected execution to throw error, but it succeeded');
      } catch (e: any) {
        expect(e.message).toMatch(expectedError);
      }
    });
  });
};

export const runParametricTest = (
  name: string,
  nodes: any[],
  verify: (ctx: EvaluationContext) => void | Promise<void>,
  resources: any[] = [],
  extraEdges: any[] = [],
  localVars: any[] = [{ id: 'res', type: 'any' }],
  structs: any[] = [],
  backends: TestBackend[] = [CpuBackend]
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}]`, async () => {
      const ir = buildSimpleIR(name, nodes, resources, extraEdges, localVars, structs);
      const ctx = await backend.execute(ir, 'main');
      await verify(ctx);
    });
  });
};

export const runFullGraphTest = (
  name: string,
  ir: IRDocument,
  verify: (ctx: EvaluationContext) => void | Promise<void>,
  backends: TestBackend[] = [CpuBackend]
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}]`, async () => {
      const ctx = await backend.execute(ir, ir.entryPoint);
      await verify(ctx);
    });
  });
};

export const runFullGraphErrorTest = (
  name: string,
  ir: IRDocument,
  expectedError: string | RegExp,
  backends: TestBackend[] = [CpuBackend]
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}] - Expect Error`, async () => {
      try {
        await backend.execute(ir, ir.entryPoint);
        expect.fail('Expected execution to throw error, but it succeeded');
      } catch (e: any) {
        expect(e.message).toMatch(expectedError);
      }
    });
  });
};
