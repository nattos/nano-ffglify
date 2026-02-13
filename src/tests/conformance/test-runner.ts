import { expect, it } from 'vitest';
import { EvaluationContext } from '../../interpreter/context';
import { IRDocument, FunctionType } from '../../ir/types';
import { TestBackend } from './types';
import { BrowserCpuBackend, BrowserGpuBackend } from './puppeteer-backend';
import { CppMetalBackend } from './cppmetal-backend';
import { MetalBackend } from './metal-backend';

const backends = [BrowserCpuBackend, BrowserGpuBackend, CppMetalBackend, MetalBackend];

export const availableBackends = process.env.TEST_BACKEND
  ? backends.filter(b => b.name === process.env.TEST_BACKEND)
  : backends;
export const cpuBackends = availableBackends.filter(backend => [BrowserCpuBackend, CppMetalBackend].includes(backend));
export const gpuBackends = availableBackends.filter(backend => [BrowserGpuBackend, MetalBackend].includes(backend));

if (process.env.TEST_BACKEND && availableBackends.length === 0) {
  console.warn(`[TestRunner] Warning: No backend found matching TEST_BACKEND='${process.env.TEST_BACKEND}'. Available: ${backends.map(b => b.name).join(', ')}`);
}

// ------------------------------------------------------------------
// Test Helpers
// ------------------------------------------------------------------

export const buildSimpleIR = (name: string, nodes: any[], resources: any[] = [], extraEdges: any[] = [], localVars: any[] = [{ id: 'res', type: 'float' }], structs: any[] = [], globalVars: any[] = [], functionType: FunctionType = 'cpu'): IRDocument => {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Helper to set nested property (e.g. "values.pos" or "values[0]")
  const setNested = (obj: any, path: string, value: any) => {
    const parts = path.split(/\.|(?=\[)/);
    let curr = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      let part = parts[i];
      if (part.endsWith(']')) { // shouldn't happen for intermediate
        part = part.slice(0, -1);
      }
      if (part.startsWith('[')) {
        const idx = parseInt(part.slice(1, -1));
        if (!curr[idx]) curr[idx] = {};
        curr = curr[idx];
      } else {
        if (!curr[part]) curr[part] = {};
        curr = curr[part];
      }
    }
    const last = parts[parts.length - 1];
    if (last.startsWith('[')) {
      const idx = parseInt(last.slice(1, -1));
      curr[idx] = value;
    } else {
      curr[last] = value;
    }
  };

  // Apply extra edges (execution or manual data) back to node properties
  extraEdges.forEach(e => {
    const from = nodeMap.get(e.from);
    const to = nodeMap.get(e.to);
    if (!from || !to) return;

    if (e.type === 'execution') {
      from[e.portOut || 'exec_out'] = e.to;
    } else if (e.type === 'data') {
      setNested(to, e.portIn, e.from);
    }
  });

  return {
    version: '1.0.0',
    meta: { name, debug: true },
    entryPoint: 'main',
    inputs: globalVars,
    resources: resources,
    structs: structs,
    functions: [{
      id: 'main',
      type: functionType,
      inputs: [],
      outputs: [],
      localVars: localVars,
      nodes: nodes
    }]
  };
};

export const runGraphTest = (
  name: string,
  nodes: any[],
  varToCheck: string,
  expectedVal: any,
  backends: TestBackend[] = availableBackends,
  builtins: Map<string, any> = new Map()
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}]`, async () => {
      // Type Inference for the result variable
      let inferredType: string = 'float';
      if (Array.isArray(expectedVal)) {
        if (expectedVal.length === 2) inferredType = 'float2';
        else if (expectedVal.length === 3) inferredType = 'float3';
        else if (expectedVal.length === 4) inferredType = 'float4';
        else if (expectedVal.length === 9) inferredType = 'float3x3';
        else if (expectedVal.length === 16) inferredType = 'float4x4';
        else inferredType = 'float[]'; // Generic array? Or float4?
      } else if (typeof expectedVal === 'number') {
        inferredType = 'float';
      } else if (typeof expectedVal === 'boolean') {
        inferredType = 'bool';
      }

      const globalVars = [
        { id: 'u_dummy', type: 'float' }
      ];
      const localVars = [
        { id: varToCheck, type: inferredType }
      ];

      // Inject func_return to return the result
      const testNodes = [...nodes, { id: 'test_return', op: 'func_return', val: varToCheck }];

      const ir = buildSimpleIR(name, testNodes, [], [], localVars, [], globalVars);

      const inputsMap = new Map<string, any>();
      inputsMap.set('u_dummy', 0.0);

      const ctx = await backend.execute(ir, 'main', inputsMap, builtins);
      try {
        const result = ctx.result !== undefined ? ctx.result : ctx.getVar(varToCheck);

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
      } finally {
        ctx.destroy();
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
  localVars: any[] = [{ id: 'res', type: 'float' }],
  backends: TestBackend[] = availableBackends,
  builtins: Map<string, any> = new Map()
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}] - Expect Error`, async () => {
      const ir = buildSimpleIR(name, nodes, resources, [], localVars, structs);
      let ctx: EvaluationContext | undefined;
      try {
        ctx = await backend.execute(ir, 'main', undefined, builtins);
        throw new Error('Expected execution to throw error, but it succeeded');
      } catch (e: any) {
        if (e.message === 'Expected execution to throw error, but it succeeded') throw e;
        if (e.name === 'AssertionError') throw e;
        expect(e.message).toMatch(expectedError);
      } finally {
        ctx?.destroy();
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
  localVars: any[] = [{ id: 'res', type: 'float' }],
  structs: any[] = [],
  backends: TestBackend[] = availableBackends,
  builtins: Map<string, any> = new Map()
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}]`, async () => {
      const ir = buildSimpleIR(name, nodes, resources, extraEdges, localVars, structs);
      const ctx = await backend.execute(ir, 'main', undefined, builtins);
      try {
        await verify(ctx);
      } finally {
        ctx.destroy();
      }
    });
  });
};

export const runFullGraphTest = (
  name: string,
  ir: IRDocument,
  verify: (ctx: EvaluationContext) => void | Promise<void>,
  backends: TestBackend[] = availableBackends,
  timeout?: number,
  builtins: Map<string, any> = new Map()
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}]`, async () => {
      const ctx = await backend.execute(ir, ir.entryPoint, undefined, builtins);
      try {
        await verify(ctx);
      } finally {
        ctx.destroy();
      }
    }, timeout);
  });
};

export const runFullGraphErrorTest = (
  name: string,
  ir: IRDocument,
  expectedError: string | RegExp,
  backends: TestBackend[] = availableBackends,
  builtins: Map<string, any> = new Map()
) => {
  backends.forEach(backend => {
    it(`${name} [${backend.name}] - Expect Error`, async () => {
      let ctx: EvaluationContext | undefined;
      try {
        ctx = await backend.execute(ir, ir.entryPoint, undefined, builtins);
        throw new Error('Expected execution to throw error, but it succeeded');
      } catch (e: any) {
        if (e.message === 'Expected execution to throw error, but it succeeded') throw e;
        if (e.name === 'AssertionError') throw e;
        expect(e.message).toMatch(expectedError);
      } finally {
        ctx?.destroy();
      }
    });
  });
};
