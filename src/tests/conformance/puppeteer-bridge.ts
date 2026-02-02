
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

// Placeholder for Phase 2
(window as any).runGpuTest = async (ir: any, inputs: any) => {
  console.log('[Bridge] runGpuTest called (Phase 2 placeholder)');
  return { status: 'Phase 2 not implemented' };
};

console.log('[Bridge] Initialized');
(window as any).bridgeReady = true;
