import puppeteer, { Browser, Page } from 'puppeteer';
import { TestBackend } from './types';
import { IRDocument } from '../../ir/types';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';

let sharedBrowser: Browser | null = null;
let sharedPage: Page | null = null;

if (import.meta.env.DEV) {
  const originalLog = console.log;
  console.log = (...args) => {
    if (args[0] && typeof args[0] === 'string') {
      if (args[0].startsWith('[Browser] [vite] ') ||
        args[0].includes('[Browser] Failed to load resource: the server responded with a status of 404 (Not Found)')) {
        return; // Silence vite logs
      }
    }
    originalLog(...args);
  };
}

async function getBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu']
    });
  }
  return sharedBrowser;
}

async function getPage() {
  if (!sharedPage) {
    const browser = await getBrowser();
    sharedPage = await browser.newPage();

    // Log browser console to Node.js
    sharedPage.on('console', msg => console.log(`[Browser] ${msg.text()}`));
    sharedPage.on('pageerror', err => console.error(`[Browser Error] ${err.message}`));

    // Load the bridge page
    // We assume the dev server is running at http://localhost:5173
    // Since Vite root is 'src', the path is relative to src.
    await sharedPage.goto('http://localhost:5173/tests/conformance/bridge.html');

    // Wait for bridge to be ready
    await sharedPage.waitForFunction(() => (window as any).bridgeReady === true);
  }
  return sharedPage;
}

// Helper for 'run' logic to avoid duplication in execute
const runImplementation = async (ctx: EvaluationContext, entryPoint: string, subBackend: string) => {
  const page = await getPage();

  // Convert inputs Map to plain object for serialization
  const inputsObj: Record<string, any> = {};
  ctx.inputs.forEach((val, key) => {
    inputsObj[key] = val;
  });

  // Convert builtins Map to plain object for serialization
  const builtinsObj: Record<string, any> = {};
  ctx.builtins.forEach((val, key) => {
    builtinsObj[key] = val;
  });

  // Serialize resources
  const resourcesObj: Record<string, any> = {};
  ctx.resources.forEach((state, key) => {
    // Enforce default viewport size for tests if 1x1
    if (state.def.size?.mode === 'viewport') {
      if (state.width === 1 && state.height === 1) {
        state.width = 64;
        state.height = 64;
        const count = 64 * 64;
        if (state.def.persistence.clearValue !== undefined) {
          state.data = new Array(count).fill(state.def.persistence.clearValue);
        } else {
          state.data = new Array(count).fill(0);
        }
      }
    }

    resourcesObj[key] = {
      width: state.width,
      height: state.height,
      data: state.data,
    };
  });

  // Run the test in the browser
  const backendName = subBackend;
  const results = await page.evaluate(
    async (ir, ep, inputs, resources, bName, builtins) => {
      const res = await (window as any).runGpuTest(ir, ep, inputs, resources, bName, builtins);
      // Serialize special float values to avoid JSON.stringify converting to null
      if (res && res.vars) {
        for (const k in res.vars) {
          const v = res.vars[k];
          if (typeof v === 'number') {
            if (Number.isNaN(v)) res.vars[k] = 'NaN';
            else if (v === Infinity) res.vars[k] = 'Infinity';
            else if (v === -Infinity) res.vars[k] = '-Infinity';
          }
        }
      }
      return res;
    },
    ctx.ir,
    entryPoint,
    inputsObj,
    resourcesObj,
    backendName,
    builtinsObj
  ) as any;

  // Populate context with results
  ctx.pushFrame(entryPoint);

  if (results !== undefined && results !== null && results.result !== undefined) {
    let res = results.result;
    if (res === 'NaN') res = NaN;
    else if (res === 'Infinity') res = Infinity;
    else if (res === '-Infinity') res = -Infinity;
    ctx.result = res;
  }

  if (results && typeof results === 'object' && results.vars) {
    for (const [key, val] of Object.entries(results.vars)) {
      let v = val;
      // Parse special float values
      if (v === 'NaN') v = NaN;
      else if (v === 'Infinity') v = Infinity;
      else if (v === '-Infinity') v = -Infinity;
      ctx.setVar(key, v as any);
    }
  }

  if (results.resources) {
    for (const [key, res] of Object.entries(results.resources)) {
      const state = ctx.getResource(key);
      const r = res as any;
      state.width = r.width;
      state.height = r.height;
      state.data = r.data;
    }
  }

  if (results.log && Array.isArray(results.log)) {
    ctx.log.push(...results.log);
  }
};

/**
 * The backend executes mostly JS (CPU), but allows dispatching through
 * the normal mechanisms to GPU, using WebGPU.
 */
export const BrowserCpuBackend: TestBackend = {
  name: 'CPU',
  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map(), builtins?: Map<string, RuntimeValue>) => {
    const ctx = new EvaluationContext(ir, inputs);
    if (builtins) {
      builtins.forEach((v, k) => ctx.builtins.set(k, v));
    }
    return ctx;
  },
  run: async (ctx: EvaluationContext, entryPoint: string) => {
    await runImplementation(ctx, entryPoint, 'WebGPU');
  },
  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map(), builtins?: Map<string, RuntimeValue>) => {
    const ctx = await BrowserCpuBackend.createContext(ir, inputs, builtins);
    await runImplementation(ctx, entryPoint, 'WebGPU');
    return ctx;
  }
};

/**
 * The backend emulates putting code directly on the GPU, using a mock
 * dispatch, and WebGPU.
 */
export const BrowserGpuBackend: TestBackend = {
  name: 'GPU',
  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map(), builtins?: Map<string, RuntimeValue>) => {
    const ctx = new EvaluationContext(ir, inputs);
    if (builtins) {
      builtins.forEach((v, k) => ctx.builtins.set(k, v));
    }
    return ctx;
  },
  run: async (ctx: EvaluationContext, entryPoint: string) => {
    await runImplementation(ctx, entryPoint, 'ForceOntoGPU');
  },
  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map(), builtins?: Map<string, RuntimeValue>) => {
    const ctx = await BrowserGpuBackend.createContext(ir, inputs, builtins);
    await runImplementation(ctx, entryPoint, 'ForceOntoGPU');
    return ctx;
  }
};

// Cleanup on exit
process.on('exit', async () => {
  if (sharedBrowser) {
    await sharedBrowser.close();
  }
});
