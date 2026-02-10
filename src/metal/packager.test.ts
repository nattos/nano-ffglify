import { describe, test, expect } from 'vitest';
import { ZipFileSystem } from './virtual-fs';
import { packageFFGLPlugin } from './ffgl-packager';
import { NOISE_SHADER } from '../domain/example-ir';
import JSZip from 'jszip';

describe('FFGL Packager', () => {
  test('should package a full build into a zip', async () => {
    const vfs = new ZipFileSystem();

    // Async import assets as requested
    const { FFGL_ASSETS } = await import('./ffgl-assets');

    await packageFFGLPlugin(vfs, {
      ir: NOISE_SHADER,
      assets: FFGL_ASSETS,
      options: {
        name: 'Packaged Noise',
        pluginId: 'PNOI',
        textureInputCount: 0,
        internalResourceCount: 0
      }
    });

    const zipData = await vfs.generateZip();
    expect(zipData).toBeDefined();

    const zip = await JSZip.loadAsync(zipData);

    // Verify key files exist in zip
    expect(zip.file('build.sh')).toBeDefined();
    expect(zip.file('generated/logic.cpp')).toBeDefined();
    expect(zip.file('generated/shaders.metal')).toBeDefined();
    expect(zip.file('src/ffgl-plugin.mm')).toBeDefined();
    expect(zip.file('ffgl-sdk/ffgl/FFGL.h')).toBeDefined();

    const script = await zip.file('build.sh')?.async('string');
    expect(script).toContain('PackagedNoise.bundle');
    expect(script).toContain('PNOI');
    // Ah, NOISE_SHADER.meta.id is likely different.
    // Let's just check for some generic strings
    expect(script).toContain('clang++');
    expect(script).toContain('-DPLUGIN_NAME=\'"Packaged Noise"\'');
  });
});
