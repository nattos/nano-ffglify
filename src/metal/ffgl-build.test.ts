
import * as path from 'path';
import * as fs from 'fs';
import { compileFFGLPlugin, compileCppHost, runMetalProgram, getMetalBuildDir } from './metal-compile';
import { execSync } from 'child_process';

describe('FFGL Build Pipeline', () => {
  const buildDir = getMetalBuildDir();
  const pluginPath = path.join(buildDir, 'NanoFFGL.bundle');
  const runnerPath = path.join(buildDir, 'ffgl-runner');

  beforeAll(() => {
    // Ensure build directory exists
    if (!fs.existsSync(buildDir)) {
      fs.mkdirSync(buildDir, { recursive: true });
    }
  });

  test('should compile FFGL plugin bundle', () => {
    // Compile the FFGL plugin
    // This uses the newly added compileFFGLPlugin function in metal-compile.ts
    // which compiles ffgl-plugin.cpp + AAPL + FFGLSDK into a .bundle
    compileFFGLPlugin({
      outputPath: pluginPath,
    });

    expect(fs.existsSync(pluginPath)).toBe(true);
    // MacOS bundle should check for actual executable inside
    // NanoFFGL.bundle/Contents/MacOS/NanoFFGL
    // But basic existence check is a good start.
    // Usually clang -bundle -o foo.bundle creates a file if it's not a directory structure.
    // Let's see what clang produces. If it produces a file, that's what we check.
  });

  test('should compile FFGL runner', () => {
    // Compile the runner
    // We repurpose compileCppHost for this, offering the runner source
    const runnerSource = path.join(__dirname, 'ffgl-runner.mm');

    // Include FFGL SDK for the runner too (it needs FFGL.h)
    const repoRoot = path.resolve(__dirname, '../..');
    const ffglSdkDir = path.join(repoRoot, 'modules/ffgl/source/lib');

    compileCppHost({
      sourcePath: runnerSource,
      outputPath: runnerPath,
      extraFlags: [`-I"${ffglSdkDir}"`, '-fobjc-arc'],
      frameworks: ['Foundation', 'Cocoa'] // Needed for NSBundle, dlopen is standard
    });

    expect(fs.existsSync(runnerPath)).toBe(true);
  });

  test('should load and initialize FFGL plugin', () => {
    // Run the runner with the plugin path
    // "ffgl-runner /path/to/plugin.bundle"

    const cmd = `"${runnerPath}" "${pluginPath}"`;
    // console.log('Running FFGL check:', cmd);

    const result = execSync(cmd, { encoding: 'utf-8' });
    const json = JSON.parse(result.trim());

    expect(json.error).toBeUndefined();
    expect(json.success).toBe(true);
  });
});
