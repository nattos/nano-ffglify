
import * as path from 'path';
import * as fs from 'fs';
import { compileFFGLPlugin, compileCppHost, runMetalProgram, getMetalBuildDir, compileMetalShader } from './metal-compile';
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
    compileFFGLPlugin({
      outputPath: pluginPath,
    });

    expect(fs.existsSync(pluginPath)).toBe(true);
  });

  test('should compile and bundle solid-color metal shader', () => {
    // 1. Compile Metal Shader to .metallib
    const shaderPath = path.join(__dirname, 'solid-color.metal');

    // compileMetalShader returns { metallibPath, airPath }
    const { metallibPath } = compileMetalShader(shaderPath, buildDir);

    // 2. Move metallib to Bundle Resources
    const resourcesDir = path.join(pluginPath, 'Contents/Resources');
    if (!fs.existsSync(resourcesDir)) {
      fs.mkdirSync(resourcesDir, { recursive: true });
    }

    const destPath = path.join(resourcesDir, 'default.metallib');
    fs.copyFileSync(metallibPath, destPath);

    expect(fs.existsSync(destPath)).toBe(true);
  });

  test('should compile FFGL runner', () => {
    const runnerSource = path.join(__dirname, 'ffgl-runner.mm');
    const repoRoot = path.resolve(__dirname, '../..');
    const ffglSdkDir = path.join(repoRoot, 'modules/ffgl/source/lib');

    compileCppHost({
      sourcePath: runnerSource,
      outputPath: runnerPath,
      extraFlags: [`-I"${ffglSdkDir}"`, '-fobjc-arc'],
      frameworks: ['Foundation', 'Cocoa', 'OpenGL']
    });

    expect(fs.existsSync(runnerPath)).toBe(true);
  });

  test('should load and initialize FFGL plugin with solid-color shader', () => {
    const cmd = `"${runnerPath}" "${pluginPath}"`;
    // console.log('Running FFGL check:', cmd);

    const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json = JSON.parse(result.trim());

    if (json.error) {
      console.error('Runner Error:', json.error);
    }

    expect(json.error).toBeUndefined();
    expect(json.success).toBe(true);
    expect(json.width).toBe(640);
    expect(json.height).toBe(480);
    expect(json.image).toBeDefined();
    expect(json.image.length).toBeGreaterThan(0);

    const buffer = Buffer.from(json.image, 'base64');
    expect(buffer.length).toBe(640 * 480 * 4); // RGBA

    // Check center pixel (320, 240)
    // The shader writes Magenta (1, 0, 1, 1) to a BGRA texture.
    // However, the FFGL blit shader reads it.
    // Metal (BGRA) -> OpenGl (Texture)
    // If we assume the interop works correctly, we should just check for valid data.
    // Magenta: R=255, G=0, B=255, A=255

    // Let's just scan for non-zero/non-black pixels first to be safe against coordinate system flukes
    let nonBlackPixels = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      const r = buffer[i];
      const g = buffer[i + 1];
      const b = buffer[i + 2];
      const a = buffer[i + 3];

      // Check for Magenta-ish or at least non-black, non-transparent
      if (a > 0 && (r > 0 || g > 0 || b > 0)) {
        nonBlackPixels++;
      }
    }

    // We expect the whole screen to be filled
    expect(nonBlackPixels).toBeGreaterThan(640 * 480 * 0.9);

    // Let's inspect the center pixel specifically for Magenta
    const centerOffset = (240 * 640 + 320) * 4;
    const r = buffer[centerOffset];
    const g = buffer[centerOffset + 1];
    const b = buffer[centerOffset + 2];
    const a = buffer[centerOffset + 3];

    // console.log(`Center Pixel: R=${r}, G=${g}, B=${b}, A=${a}`);

    expect(a).toBe(255);
    // Since it's Magenta, we expect high R and B
    expect(r).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
    expect(g).toBeLessThan(50);
  });
});
