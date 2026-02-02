import { describe, it, expect } from 'vitest';
import { PuppeteerBackend } from './puppeteer-backend';

describe('Puppeteer Phase 1 Verification', () => {

  it('should echo data back from the browser', async () => {
    const testData = { foo: 'bar', count: 42, list: [1, 2, 3] };
    const result = await (PuppeteerBackend as any).echo(testData);
    expect(result).toEqual(testData);
  });

  it('should capture exceptions from the browser', async () => {
    const errorMessage = 'Test browser error';
    try {
      await (PuppeteerBackend as any).throwError(errorMessage);
      expect.fail('Should have thrown an error');
    } catch (e: any) {
      // Puppeteer wraps browser errors, but the message should contain our string
      expect(e.message).toContain(errorMessage);
    }
  });

});
