import puppeteer, { Browser, Page } from 'puppeteer';
import { TestBackend } from './types';
import { IRDocument } from '../../ir/types';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';

let sharedBrowser: Browser | null = null;
let sharedPage: Page | null = null;

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

  // Serialize resources
  const resourcesObj: Record<string, any> = {};
  ctx.resources.forEach((state, key) => {
    resourcesObj[key] = {
      width: state.width,
      height: state.height,
      data: state.data,
    };
  });

  // Run the test in the browser
  // Allow env override, but default to the configured subBackend
  const backendName = process.env.PUPPETEER_SUB_BACKEND || subBackend;
  const results = await page.evaluate(
    async (ir, ep, inputs, resources, bName) => {
      const res = await (window as any).runGpuTest(ir, ep, inputs, resources, bName);
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
    backendName
  ) as any;

  // Populate context with results
  ctx.pushFrame(entryPoint);
  if (results.vars) {
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

export const PuppeteerBackend: TestBackend = {
  name: 'Puppeteer',
  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map()) => {
    return new EvaluationContext(ir, inputs);
  },
  run: async (ctx: EvaluationContext, entryPoint: string) => {
    await runImplementation(ctx, entryPoint, 'Compute');
  },
  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = new EvaluationContext(ir, inputs);
    await runImplementation(ctx, entryPoint, 'Compute');
    return ctx;
  }
};

export const PuppeteerFullBackend: TestBackend = {
  name: 'PuppeteerFull',
  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map()) => {
    return new EvaluationContext(ir, inputs);
  },
  run: async (ctx: EvaluationContext, entryPoint: string) => {
    await runImplementation(ctx, entryPoint, 'WebGPU');
  },
  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = new EvaluationContext(ir, inputs);
    await runImplementation(ctx, entryPoint, 'WebGPU');
    return ctx;
  }
};

// Cleanup on exit
process.on('exit', async () => {
  if (sharedBrowser) {
    await sharedBrowser.close();
  }
});
