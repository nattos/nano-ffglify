import { InterpreterBackend } from './interpreter-backend';
import { ForceOntoGPUTestBackend } from './force-on-gpu-test-backend';
import { WebGpuBackend } from './webgpu-backend';

/**
 * Browser-side bridge for Puppeteer-based tests.
 */

(window as any).echo = (data: any) => {
  console.log('[Bridge] Echoing data:', data);
  return data;
};

(window as any).throwError = (message: string) => {
  console.error('[Bridge] Throwing error:', message);
  throw new Error(message);
};

(window as any).runGpuTest = async (ir: any, entryPoint: string, inputsObj: any, resourcesObj: any, backendName: string) => {
  // console.log(`[Bridge] runGpuTest called with backend: ${backendName}`, { entryPoint, inputsObj });

  // Convert plain object inputs back to Map
  const inputsMap = new Map<string, any>();
  if (inputsObj) {
    for (const [key, val] of Object.entries(inputsObj)) {
      inputsMap.set(key, val);
    }
  }

  let backend = ForceOntoGPUTestBackend;
  if (backendName === 'Interpreter') backend = InterpreterBackend;
  else if (backendName === 'WebGPU') backend = WebGpuBackend;

  const ctx = await backend.createContext(ir, inputsMap);

  // Hydrate resources
  try {
    if (resourcesObj) {
      for (const [key, state] of Object.entries(resourcesObj)) {
        // console.log(`[Bridge] Hydrating resource ${key}`);
        const res = ctx.getResource(key);
        if (res && state) {
          if ((state as any).width !== undefined) res.width = (state as any).width;
          if ((state as any).height !== undefined) res.height = (state as any).height;
          if ((state as any).data !== undefined) res.data = (state as any).data;
        }
      }
    }
  } catch (e: any) {
    console.error('[Bridge] Error hydrating resources:', e.message);
    throw e;
  }

  try {
    await backend.run(ctx, entryPoint);
  } catch (e: any) {
    console.error('[Bridge] Error running backend:', e.message, e.stack);
    throw e;
  }

  // Serialize context back to plain object
  const results: any = {
    vars: {},
    resources: {},
    result: ctx.result
  };

  try {
    if (ctx.stack.length > 0) {
      const frame = ctx.currentFrame;
      frame.vars.forEach((val, key) => {
        results.vars[key] = val;
      });
    }

    ctx.resources.forEach((state, key) => {
      if (!state) {
        console.warn(`[Bridge] Resource ${key} state is undefined!`);
        return;
      }
      results.resources[key] = {
        width: state.width,
        height: state.height,
        data: state.data
      };
    });

    results.log = ctx.log;

    // Serialize result if it's a special float
    if (typeof results.result === 'number') {
      if (Number.isNaN(results.result)) results.result = 'NaN';
      else if (results.result === Infinity) results.result = 'Infinity';
      else if (results.result === -Infinity) results.result = '-Infinity';
    }
  } catch (e: any) {
    console.error('[Bridge] Error serializing results:', e.message);
    throw e;
  }

  // console.log('[Bridge] Execution complete, returning results');
  return results;
};

// console.log('[Bridge] Initialized');
(window as any).bridgeReady = true;
