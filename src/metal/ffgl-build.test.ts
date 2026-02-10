import { describe, test, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  compileMetalShader,
  compileCppHost,
  getMetalBuildDir,
  generateMetalCompileCmds,
  generateFFGLPluginCmds,
  generateBuildScript,
  generateCppCompileCmd
} from './metal-compile';
import { NOISE_SHADER } from '../domain/example-ir';
import { CppGenerator } from './cpp-generator';
import { MslGenerator } from './msl-generator';
import { ZipFileSystem } from './virtual-fs';
import { packageFFGLPlugin } from './ffgl-packager';

describe('FFGL Build Pipeline with Bash Script Generation', () => {
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

  test('should generate and compile FFGL runner via script', () => {
    const runnerSource = path.join(repoRoot, 'src/metal/ffgl-runner.mm');
    const ffglSdkDir = path.join(repoRoot, 'modules/ffgl/source/lib');

    const cmd = generateCppCompileCmd({
      sourcePaths: [
        runnerSource,
        path.join(repoRoot, 'src/metal/InteropTexture.m')
      ],
      outputPath: runnerPath,
      extraFlags: [`-I"${ffglSdkDir}"`, `-I"${path.join(repoRoot, 'tmp')}"`, '-fobjc-arc'],
      frameworks: ['Foundation', 'Cocoa', 'OpenGL', 'Metal', 'IOSurface', 'CoreVideo']
    });

    const scriptPath = path.join(buildDir, 'build_runner.sh');
    const script = generateBuildScript([cmd]);
    fs.writeFileSync(scriptPath, script);
    fs.chmodSync(scriptPath, '755');

    execSync(scriptPath, { stdio: 'inherit' });

    expect(fs.existsSync(runnerPath)).toBe(true);
  });

  test('should compile FFGL plugin bundle w/ compiled metal libs via generated script', () => {
    // 1. Generate Code
    const cppGen = new CppGenerator();
    const { code: cppCode, shaderFunctions } = cppGen.compile(NOISE_SHADER, 'fn_main_cpu');
    fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);

    const mslGen = new MslGenerator();
    const { code: mslCode } = mslGen.compileLibrary(NOISE_SHADER, shaderFunctions.map(s => s.id));
    const shaderPath = path.join(generatedDir, 'shaders.metal');
    fs.writeFileSync(shaderPath, mslCode);

    // 2. Prepare Build Steps
    const steps: string[] = [];

    // Step A: Compile Metal Shaders
    // We can use the helper to generate commands
    // Note: We need to manually handle the resulting .metallib path logic if we want to copy it later
    // or we can just rely on standard paths.
    const metalCmds = generateMetalCompileCmds(shaderPath, buildDir);
    steps.push(...metalCmds);

    // Step B: Compile FFGL Plugin
    const name = NOISE_SHADER.meta.name;
    const hash = Array.from(name).reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0);
    const id = Math.abs(hash).toString(16).slice(-4).toUpperCase().padStart(4, '0');

    // We expect the bundle to be at .../NanoFFGL.bundle initially or NoiseShader.bundle?
    // Let's stick to the previous test logic where we used pluginPath
    // But wait, the previous test updated pluginPath.
    // Let's explicitly define where we want it.
    const targetBundlePath = path.join(buildDir, 'NanoFFGL.bundle');

    const ffglCmds = generateFFGLPluginCmds({
      outputPath: targetBundlePath,
      name,
      pluginId: id,
      textureInputCount: NOISE_SHADER.inputs.filter(i => i.type === 'texture2d').length,
      internalResourceCount: NOISE_SHADER.resources.filter(r => !r.isOutput).length
    });
    steps.push(...ffglCmds);

    // Step C: Copy metallib to bundle
    // The previous logic did this manually. We need to add a shell command for it.
    // The metallib is generated at `buildDir/shaders.metallib` (derived from shaderPath basename)
    const metallibPath = path.join(buildDir, 'shaders.metallib');

    // We need to know the actual bundle path generated.
    // `generateFFGLPluginCmds` logic: if name is present, it uses name for the bundle filename.
    // "Noise Shader" -> "NoiseShader.bundle"
    const bundleName = name.replace(/\s+/g, '');
    const actualBundlePath = path.join(buildDir, `${bundleName}.bundle`);
    const resourcesDir = path.join(actualBundlePath, 'Contents/Resources');

    steps.push(`# Copy Metal Library`);
    steps.push(`mkdir -p "${resourcesDir}"`);
    steps.push(`cp "${metallibPath}" "${resourcesDir}/default.metallib"`);

    // 3. Generate and Run Script
    const script = generateBuildScript(steps);
    const scriptPath = path.join(buildDir, 'build_plugin.sh');
    fs.writeFileSync(scriptPath, script);
    fs.chmodSync(scriptPath, '755');

    console.log('Executing build script:', scriptPath);
    execSync(scriptPath, { stdio: 'inherit' });

    // 4. Verify
    expect(fs.existsSync(actualBundlePath)).toBe(true);
    // Verify metallib was copied
    expect(fs.existsSync(path.join(resourcesDir, 'default.metallib'))).toBe(true);

    // Update pluginPath for runner test
    pluginPath = actualBundlePath;
  });

  test('should execute the generated FFGL plugin', () => {
    // This part doesn't change much, just verifying the artifact works
    const cmd = `"${runnerPath}" "${pluginPath}"`;
    const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json = JSON.parse(result.trim());

    expect(json.success).toBe(true);
    expect(json.name).toBe(NOISE_SHADER.meta.name.slice(0, 16));

    // Basic image check
    expect(json.image).toBeDefined();
    const buffer = Buffer.from(json.image, 'base64');
    // Simple variance check (same as before)
    let variance = false;
    const firstR = buffer[0];
    for (let i = 0; i < buffer.length; i += 4) {
      if (Math.abs(buffer[i] - firstR) > 5) {
        variance = true;
        break;
      }
    }
    expect(variance).toBe(true);
  });

  test('should generate a monolithic build script for everything (Mixer example)', () => {
    // Let's do the Mixer example completely via one script (runner + plugin)
    // or just plugin since runner is static.
    // Let's do just the plugin but include all steps.

    const MIXER_SHADER = {
      meta: { name: 'Script Mixer' }, // Different name to avoid conflicts
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
            { id: 'gid_f', op: 'static_cast_float', val: 'gid' },
            { id: 'uv', op: 'math_div', a: 'gid_f', b: 'size' },
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

    // 1. Generate Logic/Shader Code
    const cppGen = new CppGenerator();
    // @ts-ignore
    const { code: cppCode, shaderFunctions } = cppGen.compile(MIXER_SHADER, 'fn_main_cpu');
    fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);

    const mslGen = new MslGenerator();
    // @ts-ignore
    const { code: mslCode } = mslGen.compileLibrary(MIXER_SHADER, shaderFunctions.map(s => s.id));
    const shaderPath = path.join(generatedDir, 'shaders.metal');
    fs.writeFileSync(shaderPath, mslCode);

    // 2. Build Steps
    const steps: string[] = [];
    const buildPath = path.join(buildDir, 'ScriptMixer'); // clean dir for this test?
    steps.push(`mkdir -p "${buildPath}"`);

    // Metal
    steps.push(...generateMetalCompileCmds(shaderPath, buildPath));

    // FFGL
    const bundlePath = path.join(buildPath, 'ScriptMixer.bundle');
    const ffglCmds = generateFFGLPluginCmds({
      outputPath: bundlePath,
      name: 'Script Mixer',
      pluginId: 'SMIX',
      textureInputCount: 2,
      internalResourceCount: 0
    });
    steps.push(...ffglCmds);

    // Copy Metallib
    const bundleName = 'ScriptMixer';
    const actualBundlePath = path.join(buildPath, `${bundleName}.bundle`);
    const resourcesDir = path.join(actualBundlePath, 'Contents/Resources');
    steps.push(`mkdir -p "${resourcesDir}"`);
    // metal-compile generator uses basenames for outputs
    steps.push(`cp "${path.join(buildPath, 'shaders.metallib')}" "${resourcesDir}/default.metallib"`);

    // 3. Run Build
    const scriptPath = path.join(buildDir, 'build_mixer.sh');
    fs.writeFileSync(scriptPath, generateBuildScript(steps));
    fs.chmodSync(scriptPath, '755');
    execSync(scriptPath, { stdio: 'inherit' });

    // 4. Verify Execution
    const cmd = `"${runnerPath}" "${actualBundlePath}"`;
    const runResult = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json = JSON.parse(runResult.trim());
    expect(json.success).toBe(true);
    expect(json.id).toBe('SMIX');
  });

  test('should compile ISOLATED plugin with relative paths and staged deps', async () => {
    // This test simulates the "export to folder" case where we copy everything to a temp dir and build from there.

    const stageDir = path.join(buildDir, 'stage_mix');
    if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });


    // 1. Stage Dependencies using packageFFGLPlugin
    const vfs = new ZipFileSystem();
    await packageFFGLPlugin(vfs, { ir: NOISE_SHADER });

    // Generate Zip
    const zipData = await vfs.generateZip();
    const zipPath = path.join(stageDir, 'build.zip');
    fs.writeFileSync(zipPath, zipData);

    // 2. Unzip onto disk
    // We use the unzip command available on macOS
    execSync(`unzip -o "${zipPath}" -d "${stageDir}"`);

    // 3. Execute Build Script from the unzipped contents
    // The packager writes 'build.sh' to the root of the zip
    const scriptPath = path.join(stageDir, 'build.sh');
    fs.chmodSync(scriptPath, '755');

    // Run in stageDir
    execSync(`./build.sh`, { cwd: stageDir, stdio: 'inherit' });

    // 4. Verify
    // The packager derived bundle name: "Simple Noise Generator" -> "SimpleNoiseGenerator.bundle"
    // and puts it in the 'build' folder (see ffgl-packager.ts)
    const finalBundlePath = path.join(stageDir, 'build/SimpleNoiseGenerator.bundle');
    expect(fs.existsSync(finalBundlePath)).toBe(true);

    // Run it
    const cmd = `"${runnerPath}" "${finalBundlePath}"`;
    const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const json = JSON.parse(result.trim());
    expect(json.success).toBe(true);
    // Derived ID from "Simple Noise Generator" hash is E541
    expect(json.id).toBe('E541');
  });
});
