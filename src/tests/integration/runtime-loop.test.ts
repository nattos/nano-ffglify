import { describe, it, expect, beforeAll } from 'vitest';
import puppeteer, { Browser, Page } from 'puppeteer';
import { IRDocument, TextureFormat } from '../../ir/types';

let sharedBrowser: Browser | null = null;
let sharedPage: Page | null = null;

if (import.meta.env.DEV) {
  const originalLog = console.log;
  console.log = (...args) => {
    if (args[0] && typeof args[0] === 'string') {
      if (args[0].startsWith('[Browser] [vite] ') ||
        args[0].includes('[Browser] Failed to load resource: the server responded with a status of 404 (Not Found)')) {
        return;
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
    sharedPage.on('console', msg => console.log(`[Browser] ${msg.text()}`));
    sharedPage.on('pageerror', err => console.error(`[Browser Error] ${err.message}`));

    await sharedPage.goto('http://localhost:5173/tests/integration/runtime-bridge.html');
    await sharedPage.waitForFunction(() => (window as any).runtimeBridgeReady === true, { timeout: 15000 });
  }
  return sharedPage;
}

process.on('exit', async () => {
  if (sharedBrowser) {
    await sharedBrowser.close();
  }
});

// ---------------------------------------------------------------------------
// IR Factory
// ---------------------------------------------------------------------------

function makeSolidColorIR(name: string, r: number, g: number, b: number): IRDocument {
  return {
    version: '1.0.0',
    meta: { name },
    entryPoint: 'main',
    inputs: [],
    resources: [{
      id: 't_output',
      type: 'texture2d',
      format: TextureFormat.RGBA8,
      size: { mode: 'fixed', value: [4, 4] },
      isOutput: true,
      persistence: { retain: false, clearOnResize: true, clearEveryFrame: true, cpuAccess: true }
    }],
    structs: [],
    functions: [
      {
        id: 'main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'dispatch', op: 'cmd_dispatch', func: 'fill', threads: [4, 4, 1] }
        ]
      },
      {
        id: 'fill',
        type: 'shader',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: [
          { id: 'gid', op: 'builtin_get', name: 'global_invocation_id' },
          { id: 'color', op: 'float4', x: r, y: g, z: b, w: 1.0 },
          { id: 'store', op: 'texture_store', tex: 't_output', coords: 'gid.xy', value: 'color' }
        ]
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Assertion Helpers
// ---------------------------------------------------------------------------

function assertAllPixels(
  result: { pixels: number[][]; width: number; height: number },
  expected: [number, number, number, number],
  tolerance = 1
) {
  const { pixels, width, height } = result;
  expect(pixels).toHaveLength(width * height);
  for (let i = 0; i < pixels.length; i++) {
    expect(pixels[i][0]).toBeCloseTo(expected[0], tolerance);
    expect(pixels[i][1]).toBeCloseTo(expected[1], tolerance);
    expect(pixels[i][2]).toBeCloseTo(expected[2], tolerance);
    expect(pixels[i][3]).toBeCloseTo(expected[3], tolerance);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: RuntimeManager + ReplManager Loop', () => {
  beforeAll(async () => {
    await getPage();
  }, 30000);

  it('compile and step produces correct output', async () => {
    const page = await getPage();

    const ir = makeSolidColorIR('Red Fill', 1.0, 0.0, 0.0);
    const result = await page.evaluate(async (commands: any) => {
      return (window as any).runRuntimeLoopTest(commands);
    }, [
      { type: 'compile', ir },
      { type: 'step' },
      { type: 'readback' },
    ] as any);

    expect(result.errors).toHaveLength(0);
    expect(result.readbacks).toHaveLength(1);
    assertAllPixels(result.readbacks[0], [1, 0, 0, 1]);
  }, 30000);

  it('hot-swap to different shader changes output', async () => {
    const page = await getPage();

    const redIR = makeSolidColorIR('Red Fill', 1.0, 0.0, 0.0);
    const blueIR = makeSolidColorIR('Blue Fill', 0.0, 0.0, 1.0);
    const result = await page.evaluate(async (commands: any) => {
      return (window as any).runRuntimeLoopTest(commands);
    }, [
      { type: 'compile', ir: redIR },
      { type: 'step' },
      { type: 'readback' },
      { type: 'compile', ir: blueIR },
      { type: 'step' },
      { type: 'readback' },
    ] as any);

    expect(result.errors).toHaveLength(0);
    expect(result.readbacks).toHaveLength(2);
    assertAllPixels(result.readbacks[0], [1, 0, 0, 1]);
    assertAllPixels(result.readbacks[1], [0, 0, 1, 1]);
  }, 30000);

  it('multiple steps produce consistent output', async () => {
    const page = await getPage();

    const ir = makeSolidColorIR('Green Fill', 0.0, 1.0, 0.0);
    const result = await page.evaluate(async (commands: any) => {
      return (window as any).runRuntimeLoopTest(commands);
    }, [
      { type: 'compile', ir },
      { type: 'step' },
      { type: 'step' },
      { type: 'step' },
      { type: 'readback' },
    ] as any);

    expect(result.errors).toHaveLength(0);
    expect(result.readbacks).toHaveLength(1);
    assertAllPixels(result.readbacks[0], [0, 1, 0, 1]);
  }, 30000);

  it('compilation failure preserves previous state', async () => {
    const page = await getPage();

    const redIR = makeSolidColorIR('Red Fill', 1.0, 0.0, 0.0);
    // Invalid IR: no functions, missing entry point function
    const invalidIR: IRDocument = {
      version: '1.0.0',
      meta: { name: 'Invalid' },
      entryPoint: 'nonexistent',
      inputs: [],
      resources: [],
      structs: [],
      functions: []
    };

    const result = await page.evaluate(async (commands: any) => {
      return (window as any).runRuntimeLoopTest(commands);
    }, [
      { type: 'compile', ir: redIR },
      { type: 'step' },
      { type: 'readback' },
      { type: 'compile', ir: invalidIR },
      { type: 'step' },
      { type: 'readback' },
    ] as any);

    // The invalid compile should produce an error
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    // First readback should be red
    expect(result.readbacks.length).toBeGreaterThanOrEqual(1);
    assertAllPixels(result.readbacks[0], [1, 0, 0, 1]);

    // Second readback (if present) should still be red — invalid compile didn't replace the pipeline
    if (result.readbacks.length >= 2) {
      assertAllPixels(result.readbacks[1], [1, 0, 0, 1]);
    }
  }, 30000);
});
