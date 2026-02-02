import { InterpreterBackend } from './interpreter-backend';
import { ComputeTestBackend } from './compute-test-backend';

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

(window as any).runGpuTest = async (ir: any, entryPoint: string, inputsObj: any, backendName: string = 'Compute') => {
  console.log(`[Bridge] runGpuTest called with backend: ${backendName}`, { entryPoint, inputsObj });

  // Convert plain object inputs back to Map
  const inputsMap = new Map<string, any>();
  if (inputsObj) {
    for (const [key, val] of Object.entries(inputsObj)) {
      inputsMap.set(key, val);
    }
  }

  const backend = backendName === 'Interpreter' ? InterpreterBackend : ComputeTestBackend;
  const ctx = await backend.execute(ir, entryPoint, inputsMap);

  // Serialize context back to plain object
  // We only need the results (vars from the top frame) and resources for now
  const results: any = {
    vars: {},
    resources: {}
  };

  if (ctx.stack.length > 0) {
    const frame = ctx.currentFrame;
    frame.vars.forEach((val, key) => {
      results.vars[key] = val;
    });
  }

  ctx.resources.forEach((state, key) => {
    results.resources[key] = {
      width: state.width,
      height: state.height,
      data: state.data
    };
  });

  console.log('[Bridge] Execution complete, returning results');
  return results;
};

console.log('[Bridge] Initialized');
(window as any).bridgeReady = true;
