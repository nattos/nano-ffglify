import { describe, test, expect } from 'vitest';
import { ZipFileSystem, ShellScriptFileSystem } from './virtual-fs';
import { packageFFGLPlugin, registerFFGLRemotes } from './ffgl-packager';
import { NOISE_SHADER } from '../domain/example-ir';
import JSZip from 'jszip';

describe('FFGL Packager', () => {
  test('should package a full build into a zip', async () => {
    const vfs = new ZipFileSystem();

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
    expect(zip.file('generated/msl-intrinsics.incl.h')).toBeDefined();
    expect(zip.file('src/ffgl-plugin.mm')).toBeDefined();
    expect(zip.file('ffgl-sdk/ffgl/FFGL.h')).toBeDefined();

    const script = await zip.file('build.sh')?.async('string');
    expect(script).toContain('SimpleNoiseGenerator.bundle');
    expect(script).toContain('clang++');
    expect(script).toContain('-DPLUGIN_NAME=\'"Simple Noise Generator"\'');

    // Verify MSL includes the intrinsics header
    const msl = await zip.file('generated/shaders.metal')?.async('string');
    expect(msl).toContain('#include "msl-intrinsics.incl.h"');
  });

  test('should package a shell script with curl downloads', async () => {
    const vfs = new ShellScriptFileSystem({ buildName: 'SimpleNoiseGenerator' });
    registerFFGLRemotes(vfs);

    await packageFFGLPlugin(vfs, {
      ir: NOISE_SHADER
    });

    const scriptData = await vfs.generateZip();
    expect(scriptData).toBeDefined();

    const script = new TextDecoder().decode(scriptData);

    // Verify script structure
    expect(script).toMatch(/^#!\/bin\/bash/);
    expect(script).toContain('set -e');
    expect(script).toContain('xcode-select');

    // Verify remote file downloads
    expect(script).toContain('curl -sfL');
    expect(script).toContain('resolume/ffgl');
    expect(script).toContain('FFGL.cpp');
    expect(script).toContain('ffgl-plugin.mm');
    expect(script).toContain('msl-intrinsics.incl.h');
    expect(script).toContain('intrinsics.incl.h');

    // Verify inlined generated code via heredocs
    expect(script).toContain('logic.cpp');
    expect(script).toContain('shaders.metal');
    expect(script).toContain('build.sh');

    // Verify error trap
    expect(script).toContain('trap');
    expect(script).toContain('ERROR: Command failed');

    // Verify progress output
    expect(script).toMatch(/\[\d+\/\d+\]/);

    // Verify build step
    expect(script).toContain('./build.sh');

    // Verify FFGL SDK source code is NOT inlined (only referenced by path in build.sh)
    // The actual C++ code content should not appear in the script
    expect(script).not.toContain('FreeFrame is an open-source');

    // Verify msl-intrinsics is downloaded, not inlined as a heredoc
    // It should appear in curl commands but not in cat heredocs
    expect(script).toContain('curl -sfL');
    expect(script).toMatch(/curl.*msl-intrinsics\.incl\.h/);
    expect(script).not.toContain('inline float safe_div');
  });

  test('should use cp in local mode', async () => {
    const vfs = new ShellScriptFileSystem({
      buildName: 'SimpleNoiseGenerator',
      localMode: true,
      localBasePath: '/path/to/repo',
    });
    registerFFGLRemotes(vfs);

    await packageFFGLPlugin(vfs, {
      ir: NOISE_SHADER
    });

    const scriptData = await vfs.generateZip();
    const script = new TextDecoder().decode(scriptData);

    // Local mode uses cp instead of curl
    expect(script).toContain('cp "/path/to/repo/');
    expect(script).not.toContain('curl');
  });
});
