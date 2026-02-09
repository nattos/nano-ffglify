import { describe, test, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { compileMetalShader, compileFFGLPlugin, compileCppHost, getMetalBuildDir } from './metal-compile';
import { NOISE_SHADER } from '../domain/example-ir';
import { CppGenerator } from './cpp-generator';
import { MslGenerator } from './msl-generator';

describe('FFGL Build Pipeline', () => {
  const buildDir = getMetalBuildDir();
  const repoRoot = path.resolve(__dirname, '../..');
  let pluginPath = path.join(buildDir, 'NanoFFGL.bundle');
  const runnerPath = path.join(buildDir, 'ffgl-runner');
  const generatedDir = path.join(repoRoot, 'src/metal/generated');

  beforeAll(() => {
    if (!fs.existsSync(generatedDir)) {
      fs.mkdirSync(generatedDir, { recursive: true });
    }
    // Create a dummy logic.cpp if it doesn't exist to allow initial compilation
    if (!fs.existsSync(path.join(generatedDir, 'logic.cpp'))) {
      fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), 'void func_main(EvalContext& ctx) {}');
    }
  });

  test('should compile FFGL runner', () => {
    const runnerSource = path.join(repoRoot, 'src/metal/ffgl-runner.mm');
    const ffglSdkDir = path.join(repoRoot, 'modules/ffgl/source/lib');

    compileCppHost({
      sourcePath: runnerSource,
      outputPath: runnerPath,
      extraFlags: [`-I"${ffglSdkDir}"`, '-fobjc-arc'],
      frameworks: ['Foundation', 'Cocoa', 'OpenGL']
    });

    expect(fs.existsSync(runnerPath)).toBe(true);
  });

  test('should generate NOISE_SHADER code', () => {
    const cppGen = new CppGenerator();
    const { code: cppCode, shaderFunctions } = cppGen.compile(NOISE_SHADER, 'fn_main_cpu');

    // Write Logic
    fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);

    // Write Shaders
    if (shaderFunctions.length > 0) {
      const mslGen = new MslGenerator();
      const { code: mslCode } = mslGen.compileLibrary(NOISE_SHADER, shaderFunctions.map(s => s.id));
      const shaderPath = path.join(generatedDir, 'shaders.metal');
      fs.writeFileSync(shaderPath, mslCode);

      // Compile Shaders
      const { metallibPath } = compileMetalShader(shaderPath, buildDir);

      // We'll bundle this in the next step
      expect(fs.existsSync(metallibPath)).toBe(true);
    }
  });

  test('should compile FFGL plugin bundle with generated logic and metadata', () => {
    const name = NOISE_SHADER.meta.name;
    // Simple hash for 4-char ID
    const hash = Array.from(name).reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0);
    const id = Math.abs(hash).toString(16).slice(-4).toUpperCase().padStart(4, '0');

    const result = compileFFGLPlugin({
      outputPath: pluginPath,
      name,
      pluginId: id
    });

    const expectedName = name.replace(/\s+/g, '');
    const expectedPath = path.join(path.dirname(pluginPath), `${expectedName}.bundle`);

    expect(result).toBe(expectedPath);
    expect(fs.existsSync(result)).toBe(true);

    // Update pluginPath for subsequent tests
    pluginPath = result;

    // Copy the compiled metallib (if it was generated) to the bundle
    const metallibPath = path.join(buildDir, 'shaders.metallib');
    if (fs.existsSync(metallibPath)) {
      const resourcesDir = path.join(pluginPath, 'Contents/Resources');
      if (!fs.existsSync(resourcesDir)) {
        fs.mkdirSync(resourcesDir, { recursive: true });
      }
      fs.copyFileSync(metallibPath, path.join(resourcesDir, 'default.metallib'));
    }
  });

  test('should load and initialize FFGL plugin with noise shader', () => {
    const cmd = `"${runnerPath}" "${pluginPath}"`;
    const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json = JSON.parse(result.trim());

    if (json.error) {
      console.error('Runner Error:', json.error);
    }

    expect(json.error).toBeUndefined();
    expect(json.success).toBe(true);

    // Verify name from metadata (FFGL header caps at 16 chars)
    expect(json.name).toBe(NOISE_SHADER.meta.name.slice(0, 16));
    expect(json.width).toBe(640);
    expect(json.height).toBe(480);
    expect(json.image).toBeDefined();
    expect(json.image.length).toBeGreaterThan(0);

    const buffer = Buffer.from(json.image, 'base64');

    // Verify Output is NOT a solid color
    let variance = false;
    const firstR = buffer[0];
    const firstG = buffer[1];
    const firstB = buffer[2];

    for (let i = 0; i < buffer.length; i += 4) {
      const r = buffer[i];
      const g = buffer[i + 1];
      const b = buffer[i + 2];

      if (Math.abs(r - firstR) > 5 || Math.abs(g - firstG) > 5 || Math.abs(b - firstB) > 5) {
        variance = true;
        break;
      }
    }

    expect(variance).toBe(true);
  });

  test('should handle dynamic resizing', () => {
    // 1. Initial 640x480 (already tested above, but let's do a different size)
    const size1 = { w: 800, h: 600 };
    const cmd1 = `"${runnerPath}" "${pluginPath}" ${size1.w} ${size1.h}`;
    const result1 = execSync(cmd1, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json1 = JSON.parse(result1.trim());
    expect(json1.success).toBe(true);
    expect(json1.width).toBe(size1.w);
    expect(json1.height).toBe(size1.h);

    // 2. Resize to 320x240
    const size2 = { w: 320, h: 240 };
    const cmd2 = `"${runnerPath}" "${pluginPath}" ${size2.w} ${size2.h}`;
    const result2 = execSync(cmd2, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json2 = JSON.parse(result2.trim());
    expect(json2.success).toBe(true);
    expect(json2.width).toBe(size2.w);
    expect(json2.height).toBe(size2.h);
  });
});
