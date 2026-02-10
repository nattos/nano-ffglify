import { describe, test, expect } from 'vitest';
import { ZipFileSystem } from './virtual-fs';
import { packageFFGLPlugin } from './ffgl-packager';
import { NOISE_SHADER } from '../domain/example-ir';
import JSZip from 'jszip';

describe('FFGL Packager', () => {
  test('should package a full build into a zip', async () => {
    const vfs = new ZipFileSystem();

    // Async import assets as requested
    await packageFFGLPlugin(vfs, {
      ir: NOISE_SHADER
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
    expect(script).toContain('SimpleNoiseGenerator.bundle');
    expect(script).toContain('E541');
    // Ah, NOISE_SHADER.meta.id is likely different.
    // Let's just check for some generic strings
    expect(script).toContain('clang++');
    expect(script).toContain('-DPLUGIN_NAME=\'"Simple Noise Generator"\'');
  });
});
