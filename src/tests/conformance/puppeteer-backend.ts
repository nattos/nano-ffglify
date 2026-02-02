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

export const PuppeteerBackend: TestBackend = {
  name: 'Puppeteer',

  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map()) => {
    return new EvaluationContext(ir, inputs);
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    const page = await getPage();

    // Convert inputs Map to plain object for serialization
    const inputsObj: Record<string, any> = {};
    ctx.inputs.forEach((val, key) => {
      inputsObj[key] = val;
    });

    // Run the test in the browser
    const results = await page.evaluate(
      (ir, ep, inputs) => (window as any).runGpuTest(ir, ep, inputs),
      ctx.ir,
      entryPoint,
      inputsObj
    ) as any;

    // Populate context with results
    ctx.pushFrame(entryPoint);
    if (results.vars) {
      for (const [key, val] of Object.entries(results.vars)) {
        ctx.setVar(key, val as any);
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
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await PuppeteerBackend.createContext(ir, inputs);
    await PuppeteerBackend.run(ctx, entryPoint);
    return ctx;
  },

  // Extension for Phase 1 testing
  echo: async (data: any) => {
    const page = await getPage();
    return await page.evaluate((d) => (window as any).echo(d), data);
  },

  throwError: async (message: string) => {
    const page = await getPage();
    return await page.evaluate((m) => (window as any).throwError(m), message);
  }
};

// Cleanup on exit
process.on('exit', async () => {
  if (sharedBrowser) {
    await sharedBrowser.close();
  }
});
