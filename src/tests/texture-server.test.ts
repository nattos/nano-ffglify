/**
 * Texture Server WebSocket API tests
 *
 * Compiles the texture-server binary, spawns it, and exercises all
 * WebSocket endpoints via Node's built-in WebSocket client.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTextureServer, TextureServerProcess } from '../metal/texture-server-compile';

// ---------------------------------------------------------------------------
// Helper: request/response WebSocket client with id-correlation
// ---------------------------------------------------------------------------

class TextureServerClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private url: string;

  constructor(port: number) {
    this.url = `ws://127.0.0.1:${port}`;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (ev) => reject(new Error(`WebSocket error: ${ev}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        const id = msg.id;
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          if (msg.error) {
            p.reject(msg.error);
          } else {
            p.resolve(msg.result);
          }
        }
      };
      this.ws.onclose = () => {
        // Reject all pending
        for (const [, p] of this.pending) {
          p.reject(new Error('Connection closed'));
        }
        this.pending.clear();
      };
    });
  }

  async request(method: string, params: any = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    const id = `req-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${id} (${method}) timed out`));
      }, 5000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// Helper: create a small RGBA8 texture
// ---------------------------------------------------------------------------

function makeRGBA(width: number, height: number, fill: [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4 + 0] = fill[0];
    buf[i * 4 + 1] = fill[1];
    buf[i * 4 + 2] = fill[2];
    buf[i * 4 + 3] = fill[3];
  }
  return buf;
}

function makeGradientRGBA(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      buf[i + 0] = x * 255 / (width - 1) | 0;
      buf[i + 1] = y * 255 / (height - 1) | 0;
      buf[i + 2] = 128;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Texture Server WebSocket API', () => {
  let server: TextureServerProcess;
  let client: TextureServerClient;

  beforeAll(async () => {
    // Compile and start server with fast expiry for testing
    server = await startTextureServer(0, { expiry: 2 });
    client = new TextureServerClient(server.port);
    await client.connect();
  }, 30000); // 30s for compilation

  afterAll(async () => {
    client?.close();
    server?.kill();
    // Give it a moment to exit
    await new Promise(r => setTimeout(r, 200));
  });

  it('debug_list_channels returns empty initially', async () => {
    const result = await client.request('debug_list_channels');
    expect(result).toHaveProperty('channels');
    expect(result.channels).toEqual([]);
  });

  it('debug_push_texture creates a debug channel', async () => {
    const rgba = makeRGBA(4, 4, [255, 0, 0, 255]);
    const result = await client.request('debug_push_texture', {
      channel: 'test-red',
      width: 4,
      height: 4,
      data: rgba.toString('base64'),
    });
    expect(result).toEqual({ ok: true });
  });

  it('debug_read_texture reads back pushed data with pixel verification', async () => {
    // Push a known 2x2 texture
    const rgba = Buffer.alloc(2 * 2 * 4);
    // Pixel (0,0) = red
    rgba[0] = 255; rgba[1] = 0; rgba[2] = 0; rgba[3] = 255;
    // Pixel (1,0) = green
    rgba[4] = 0; rgba[5] = 255; rgba[6] = 0; rgba[7] = 255;
    // Pixel (0,1) = blue
    rgba[8] = 0; rgba[9] = 0; rgba[10] = 255; rgba[11] = 255;
    // Pixel (1,1) = white
    rgba[12] = 255; rgba[13] = 255; rgba[14] = 255; rgba[15] = 255;

    await client.request('debug_push_texture', {
      channel: 'test-pixels',
      width: 2,
      height: 2,
      data: rgba.toString('base64'),
    });

    const result = await client.request('debug_read_texture', {
      channel: 'test-pixels',
    });

    expect(result.channel).toBe('test-pixels');
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.thumbWidth).toBe(2);
    expect(result.thumbHeight).toBe(2);
    expect(result.isDebug).toBe(true);

    // Decode and verify pixels
    const readBack = Buffer.from(result.data, 'base64');
    expect(readBack.length).toBe(2 * 2 * 4);
    // Red pixel
    expect(readBack[0]).toBe(255);
    expect(readBack[1]).toBe(0);
    expect(readBack[2]).toBe(0);
    expect(readBack[3]).toBe(255);
    // Green pixel
    expect(readBack[4]).toBe(0);
    expect(readBack[5]).toBe(255);
    expect(readBack[6]).toBe(0);
    expect(readBack[7]).toBe(255);
  });

  it('debug_read_texture with maxDim returns downscaled image', async () => {
    // Push an 8x8 texture
    const rgba = makeGradientRGBA(8, 8);
    await client.request('debug_push_texture', {
      channel: 'test-downscale',
      width: 8,
      height: 8,
      data: rgba.toString('base64'),
    });

    // Read with maxDim=4
    const result = await client.request('debug_read_texture', {
      channel: 'test-downscale',
      maxDim: 4,
    });

    expect(result.width).toBe(8); // original size
    expect(result.height).toBe(8);
    expect(result.thumbWidth).toBe(4); // downscaled
    expect(result.thumbHeight).toBe(4);

    const readBack = Buffer.from(result.data, 'base64');
    expect(readBack.length).toBe(4 * 4 * 4); // 4x4 RGBA
  });

  it('debug_list_channels shows pushed channels', async () => {
    const result = await client.request('debug_list_channels');
    expect(result.channels.length).toBeGreaterThanOrEqual(1);

    const names = result.channels.map((c: any) => c.name);
    expect(names).toContain('test-red');
    expect(names).toContain('test-pixels');

    const redChannel = result.channels.find((c: any) => c.name === 'test-red');
    expect(redChannel.width).toBe(4);
    expect(redChannel.height).toBe(4);
    expect(redChannel.isDebug).toBe(true);
    expect(redChannel).toHaveProperty('expiresInMs');
  });

  it('get_time returns transport info with defaults', async () => {
    const result = await client.request('get_time');
    expect(result).toHaveProperty('frameNumber');
    expect(result).toHaveProperty('bpm');
    expect(result).toHaveProperty('phase');
    expect(result).toHaveProperty('timeSeconds');
    expect(typeof result.bpm).toBe('number');
    expect(result.bpm).toBe(120);
  });

  it('debug channel expiry removes old channels', async () => {
    // Push a channel
    const rgba = makeRGBA(2, 2, [100, 100, 100, 255]);
    await client.request('debug_push_texture', {
      channel: 'test-expiry',
      width: 2,
      height: 2,
      data: rgba.toString('base64'),
    });

    // Verify it exists
    let result = await client.request('debug_list_channels');
    let names = result.channels.map((c: any) => c.name);
    expect(names).toContain('test-expiry');

    // Wait for expiry (server started with --expiry 2)
    // Purge timer fires every 5s, so we wait up to 8s
    await new Promise(r => setTimeout(r, 8000));

    result = await client.request('debug_list_channels');
    names = result.channels.map((c: any) => c.name);
    expect(names).not.toContain('test-expiry');
  }, 15000);

  it('multiple concurrent clients can push/read independently', async () => {
    const client2 = new TextureServerClient(server.port);
    await client2.connect();

    try {
      // Client 1 pushes channel A
      const rgbaA = makeRGBA(2, 2, [10, 20, 30, 255]);
      await client.request('debug_push_texture', {
        channel: 'multi-a',
        width: 2,
        height: 2,
        data: rgbaA.toString('base64'),
      });

      // Client 2 pushes channel B
      const rgbaB = makeRGBA(2, 2, [40, 50, 60, 255]);
      await client2.request('debug_push_texture', {
        channel: 'multi-b',
        width: 2,
        height: 2,
        data: rgbaB.toString('base64'),
      });

      // Client 1 reads channel B
      const resultB = await client.request('debug_read_texture', { channel: 'multi-b' });
      const dataB = Buffer.from(resultB.data, 'base64');
      expect(dataB[0]).toBe(40);
      expect(dataB[1]).toBe(50);

      // Client 2 reads channel A
      const resultA = await client2.request('debug_read_texture', { channel: 'multi-a' });
      const dataA = Buffer.from(resultA.data, 'base64');
      expect(dataA[0]).toBe(10);
      expect(dataA[1]).toBe(20);
    } finally {
      client2.close();
    }
  });

  it('unknown method returns error', async () => {
    try {
      await client.request('nonexistent_method');
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e.code).toBe(404);
      expect(e.message).toContain('Unknown method');
    }
  });

  it('read of nonexistent channel returns error', async () => {
    try {
      await client.request('debug_read_texture', { channel: 'does-not-exist' });
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e.code).toBe(404);
      expect(e.message).toContain('Channel not found');
    }
  });

  it('debug_push_texture with upscale stores at original resolution', async () => {
    // Push a 2x2 texture but claim original is 4x4
    const rgba = makeRGBA(2, 2, [200, 100, 50, 255]);
    await client.request('debug_push_texture', {
      channel: 'test-upscale',
      width: 2,
      height: 2,
      originalWidth: 4,
      originalHeight: 4,
      data: rgba.toString('base64'),
    });

    const result = await client.request('debug_read_texture', {
      channel: 'test-upscale',
    });

    // Should be stored at original resolution
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);

    const readBack = Buffer.from(result.data, 'base64');
    expect(readBack.length).toBe(4 * 4 * 4);
    // All pixels should be the same color (nearest-neighbor upscale of uniform)
    expect(readBack[0]).toBe(200);
    expect(readBack[1]).toBe(100);
    expect(readBack[2]).toBe(50);
    expect(readBack[3]).toBe(255);
  });
});
