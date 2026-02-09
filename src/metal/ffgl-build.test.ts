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
      sourcePaths: [
        runnerSource,
        path.join(repoRoot, 'tmp/AAPLOpenGLMetalInteropTexture.m')
      ],
      outputPath: runnerPath,
      extraFlags: [`-I"${ffglSdkDir}"`, `-I"${path.join(repoRoot, 'tmp')}"`, '-fobjc-arc'],
      frameworks: ['Foundation', 'Cocoa', 'OpenGL', 'Metal', 'IOSurface', 'CoreVideo']
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
      pluginId: id,
      textureInputCount: NOISE_SHADER.inputs.filter(i => i.type === 'texture2d').length,
      internalResourceCount: NOISE_SHADER.resources.filter(r => !r.isOutput).length
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
    expect(json.type).toBe(1); // FF_SOURCE (1 in this SDK)
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

  test('should generate and compile a MIXER plugin (2 inputs)', () => {
    const MIXER_SHADER = {
      meta: { name: 'Simple Mixer' },
      resources: [
        { id: 'out_tex', type: 'texture2d', isOutput: true }
      ],
      inputs: [
        { id: 'in_tex1', type: 'texture2d' },
        { id: 'in_tex2', type: 'texture2d' },
        { id: 'mix', type: 'f32', default: 0.5 }
      ],
      functions: [
        {
          id: 'fn_mixer_gpu',
          type: 'shader',
          inputs: [{ id: 'mix_val', type: 'f32' }],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'size', op: 'resource_get_size', resource: 'out_tex' },
            { id: 'gid_raw', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'gid', op: 'vec_swizzle', vec: 'gid_raw', channels: 'xy' },
            { id: 'uv', op: 'float2', x: 0.5, y: 0.5 },
            { id: 'c1', op: 'texture_sample', tex: 'in_tex1', coords: 'uv' },
            { id: 'c2', op: 'texture_sample', tex: 'in_tex2', coords: 'uv' },
            { id: 'final_color', op: 'math_mix', a: 'c1', b: 'c2', t: 'mix_val' },
            { id: 'store', op: 'texture_store', tex: 'out_tex', coords: 'gid', value: 'final_color' }
          ]
        },
        {
          id: 'fn_main_cpu',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'out_size', op: 'resource_get_size', resource: 'out_tex' },
            { id: 'disp', op: 'cmd_dispatch', func: 'fn_mixer_gpu', dispatch: 'out_size', args: { 'mix_val': 'mix' } }
          ]
        }
      ]
    };

    const cppGen = new CppGenerator();
    // @ts-ignore
    const { code: cppCode, shaderFunctions } = cppGen.compile(MIXER_SHADER, 'fn_main_cpu');
    fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);

    const mslGen = new MslGenerator();
    // @ts-ignore
    const { code: mslCode } = mslGen.compileLibrary(MIXER_SHADER, shaderFunctions.map(s => s.id));
    const shaderPath = path.join(generatedDir, 'shaders.metal');
    fs.writeFileSync(shaderPath, mslCode);
    const { metallibPath } = compileMetalShader(shaderPath, buildDir);

    const mixerPluginPath = path.join(buildDir, 'SimpleMixer.bundle');
    const result = compileFFGLPlugin({
      outputPath: mixerPluginPath,
      name: 'Simple Mixer',
      pluginId: 'MIXR',
      textureInputCount: 2,
      internalResourceCount: MIXER_SHADER.resources.filter(r => !r.isOutput).length
    });

    expect(fs.existsSync(result)).toBe(true);

    const resourcesDir = path.join(result, 'Contents/Resources');
    if (!fs.existsSync(resourcesDir)) fs.mkdirSync(resourcesDir, { recursive: true });
    fs.copyFileSync(metallibPath, path.join(resourcesDir, 'default.metallib'));

    // Run the mixer
    const cmd = `"${runnerPath}" "${result}"`;
    const runResult = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json = JSON.parse(runResult.trim());
    expect(json.success).toBe(true);
    expect(json.id).toBe('MIXR');
    expect(json.type).toBe(2); // FF_MIXER
  });

  test('should generate and compile an EFFECT plugin (brightness)', () => {
    const BRIGHTNESS_EFFECT = {
      meta: { name: 'Brightness Effect' },
      resources: [
        { id: 'out_tex', type: 'texture2d', isOutput: true }
      ],
      inputs: [
        { id: 'in_tex', type: 'texture2d' },
        { id: 'brightness', type: 'f32', default: 0.5 }
      ],
      functions: [
        {
          id: 'fn_brightness_gpu',
          type: 'shader',
          inputs: [{ id: 'b_val', type: 'f32' }],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'size', op: 'resource_get_size', resource: 'out_tex' },
            { id: 'gid_raw', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'gid', op: 'vec_swizzle', vec: 'gid_raw', channels: 'xy' },
            { id: 'uv', op: 'float2', x: 0.5, y: 0.5 },
            { id: 'tex_color', op: 'texture_sample', tex: 'in_tex', coords: 'uv' },
            { id: 'b_vec', op: 'float4', x: 'b_val', y: 'b_val', z: 'b_val', w: 1.0 },
            { id: 'final_color', op: 'math_add', a: 'tex_color', b: 'b_vec' },
            { id: 'store', op: 'texture_store', tex: 'out_tex', coords: 'gid', value: 'final_color' }
          ]
        },
        {
          id: 'fn_main_cpu',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'out_size', op: 'resource_get_size', resource: 'out_tex' },
            { id: 'disp', op: 'cmd_dispatch', func: 'fn_brightness_gpu', dispatch: 'out_size', args: { 'b_val': 'brightness' } }
          ]
        }
      ]
    };

    const cppGen = new CppGenerator();
    // @ts-ignore
    const { code: cppCode, shaderFunctions } = cppGen.compile(BRIGHTNESS_EFFECT, 'fn_main_cpu');
    fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);

    const mslGen = new MslGenerator();
    // @ts-ignore
    const { code: mslCode } = mslGen.compileLibrary(BRIGHTNESS_EFFECT, shaderFunctions.map(s => s.id));
    const shaderPath = path.join(generatedDir, 'shaders.metal');
    fs.writeFileSync(shaderPath, mslCode);
    const { metallibPath } = compileMetalShader(shaderPath, buildDir);

    const brightnessPluginPath = path.join(buildDir, 'BrightnessEffect.bundle');
    const result = compileFFGLPlugin({
      outputPath: brightnessPluginPath,
      name: 'Brightness Effect',
      pluginId: 'BRGT',
      textureInputCount: 1,
      internalResourceCount: BRIGHTNESS_EFFECT.resources.filter(r => !r.isOutput).length
    });

    expect(fs.existsSync(result)).toBe(true);

    const resourcesDir = path.join(result, 'Contents/Resources');
    if (!fs.existsSync(resourcesDir)) fs.mkdirSync(resourcesDir, { recursive: true });
    fs.copyFileSync(metallibPath, path.join(resourcesDir, 'default.metallib'));

    // Run the brightness effect
    const cmd = `"${runnerPath}" "${result}"`;
    const runResult = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json = JSON.parse(runResult.trim());
    expect(json.success).toBe(true);
    expect(json.id).toBe('BRGT');
    expect(json.type).toBe(0); // FF_EFFECT (0 in this SDK)
    expect(json.image).toBeDefined();
    expect(json.image.length).toBeGreaterThan(0);

    const buffer = Buffer.from(json.image, 'base64');
    let hasNonZero = false;
    for (let i = 0; i < buffer.length; ++i) {
      if (buffer[i] > 0) {
        hasNonZero = true;
        break;
      }
    }
    expect(hasNonZero).toBe(true);
  });

  test('should generate and compile a PASSTHROUGH effect', () => {
    const PASSTHROUGH_EFFECT = {
      meta: { name: 'Passthrough Effect' },
      resources: [
        { id: 'out_tex', type: 'texture2d', isOutput: true }
      ],
      inputs: [
        { id: 'in_tex', type: 'texture2d' }
      ],
      functions: [
        {
          id: 'fn_pass_gpu',
          type: 'shader',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'size', op: 'resource_get_size', resource: 'out_tex' },
            { id: 'gid_raw', op: 'builtin_get', name: 'global_invocation_id' },
            { id: 'gid', op: 'vec_swizzle', vec: 'gid_raw', channels: 'xy' },
            { id: 'uv', op: 'float2', x: 0.5, y: 0.5 },
            { id: 'tex_color', op: 'texture_sample', tex: 'in_tex', coords: 'uv' },
            { id: 'store', op: 'texture_store', tex: 'out_tex', coords: 'gid', value: 'tex_color' }
          ]
        },
        {
          id: 'fn_main_cpu',
          type: 'cpu',
          inputs: [],
          outputs: [],
          localVars: [],
          nodes: [
            { id: 'out_size', op: 'resource_get_size', resource: 'out_tex' },
            { id: 'disp', op: 'cmd_dispatch', func: 'fn_pass_gpu', dispatch: 'out_size', args: {} }
          ]
        }
      ]
    };

    const cppGen = new CppGenerator();
    // @ts-ignore
    const { code: cppCode, shaderFunctions } = cppGen.compile(PASSTHROUGH_EFFECT, 'fn_main_cpu');
    fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);

    const mslGen = new MslGenerator();
    // @ts-ignore
    const { code: mslCode } = mslGen.compileLibrary(PASSTHROUGH_EFFECT, shaderFunctions.map(s => s.id));
    const shaderPath = path.join(generatedDir, 'shaders.metal');
    fs.writeFileSync(shaderPath, mslCode);
    const { metallibPath } = compileMetalShader(shaderPath, buildDir);

    const passPluginPath = path.join(buildDir, 'PassthroughEffect.bundle');
    const result = compileFFGLPlugin({
      outputPath: passPluginPath,
      name: 'Passthrough Effect',
      pluginId: 'PASS',
      textureInputCount: 1,
      internalResourceCount: 0
    });

    expect(fs.existsSync(result)).toBe(true);

    const resourcesDir = path.join(result, 'Contents/Resources');
    if (!fs.existsSync(resourcesDir)) fs.mkdirSync(resourcesDir, { recursive: true });
    fs.copyFileSync(metallibPath, path.join(resourcesDir, 'default.metallib'));

    const cmd = `"${runnerPath}" "${result}"`;
    const runResult = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json = JSON.parse(runResult.trim());
    expect(json.success).toBe(true);

    const buffer = Buffer.from(json.image, 'base64');

    // Runner fills input 0 with Horizontal Red Gradient (0 -> 255)
    // We expect the output to also be a gradient.
    // If the "single pixel scale up" bug exists, the output will be a solid color (variance ~0).
    // We check for variance in the Red channel (or Blue if swapped).

    let minVal = 255;
    let maxVal = 0;

    // Sample a row in the middle
    const row = Math.floor(json.height / 2);
    for (let x = 0; x < json.width; x++) {
      const i = (row * json.width + x) * 4;
      // Check both R and B indices to be safe against BGRA/RGBA swaps
      const val = Math.max(buffer[i], buffer[i + 2]);
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }

    const variance = maxVal - minVal;
    console.log(`Gradient Variance: ${variance} (Min: ${minVal}, Max: ${maxVal})`);

    // If it's a gradient, variance should be high close to 255.
    // If it's a solid color (bug), variance will be low < 10.
    expect(variance).toBeGreaterThan(200);
  });
});
