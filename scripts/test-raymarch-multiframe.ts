/**
 * Test RAYMARCH_SHADER FFGL plugin with multiple frames to reproduce the
 * "distorted cubic column" issue seen in Resolume.
 */
import { CppGenerator } from '../src/metal/cpp-generator';
import { MslGenerator } from '../src/metal/msl-generator';
import { RAYMARCH_SHADER } from '../src/domain/example-ir';
import {
  getMetalBuildDir,
  generateMetalCompileCmds,
  generateFFGLPluginCmds,
  generateBuildScript,
  generateCppCompileCmd
} from '../src/metal/metal-compile';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const buildDir = getMetalBuildDir();
const repoRoot = path.resolve(__dirname, '..');
const generatedDir = path.join(repoRoot, 'src/metal/generated');
const runnerPath = path.join(buildDir, 'ffgl-runner');

// Step 1: Rebuild runner (source changed)
console.log('=== Rebuilding ffgl-runner ===');
const ffglSdkDir = path.join(repoRoot, 'modules/ffgl/source/lib');
const runnerCmd = generateCppCompileCmd({
  sourcePaths: [
    path.join(repoRoot, 'src/metal/ffgl-runner.mm'),
    path.join(repoRoot, 'src/metal/InteropTexture.m')
  ],
  outputPath: runnerPath,
  extraFlags: [`-I"${ffglSdkDir}"`, `-I"${path.join(repoRoot, 'tmp')}"`, '-fobjc-arc'],
  frameworks: ['Foundation', 'Cocoa', 'OpenGL', 'Metal', 'IOSurface', 'CoreVideo']
});
const buildRunnerScript = path.join(buildDir, 'build_runner.sh');
fs.writeFileSync(buildRunnerScript, generateBuildScript([runnerCmd]));
fs.chmodSync(buildRunnerScript, '755');
execSync(buildRunnerScript, { stdio: 'inherit' });
console.log('Runner rebuilt.');

// Step 2: Generate code (if needed)
console.log('\n=== Generating code ===');
if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });
const cppGen = new CppGenerator();
const { code: cppCode, shaderFunctions } = cppGen.compile(RAYMARCH_SHADER, 'fn_main_cpu');
fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);
const mslGen = new MslGenerator();
const { code: mslCode } = mslGen.compileLibrary(RAYMARCH_SHADER, shaderFunctions.map(s => s.id));
fs.writeFileSync(path.join(generatedDir, 'shaders.metal'), mslCode);
console.log('Code generated.');

// Step 3: Build plugin
console.log('\n=== Building FFGL Plugin ===');
const steps: string[] = [];
const shaderPath = path.join(generatedDir, 'shaders.metal');
steps.push(...generateMetalCompileCmds(shaderPath, buildDir));
const bundlePath = path.join(buildDir, 'Raymarcher.bundle');
const ffglCmds = generateFFGLPluginCmds({
  outputPath: bundlePath,
  name: 'Raymarcher',
  pluginId: 'RMRC',
  textureInputCount: 0,
  internalResourceCount: 1
});
steps.push(...ffglCmds);
const resourcesDir = path.join(bundlePath, 'Contents/Resources');
steps.push(`mkdir -p "${resourcesDir}"`);
steps.push(`cp "${path.join(buildDir, 'shaders.metallib')}" "${resourcesDir}/default.metallib"`);
const scriptPath = path.join(buildDir, 'build_raymarch.sh');
fs.writeFileSync(scriptPath, generateBuildScript(steps));
fs.chmodSync(scriptPath, '755');
execSync(scriptPath, { stdio: 'inherit' });
console.log('Plugin built.');

// Step 4: Helper to run and analyze
function runAndAnalyze(frames: number, width: number, height: number): { center: number[], sky: number[], rangeR: [number,number], rangeG: [number,number], rangeB: [number,number] } {
  const cmd = `"${runnerPath}" "${bundlePath}" ${width} ${height} ${frames}`;
  const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  const json = JSON.parse(result.trim());
  const pixels = new Uint8Array(Buffer.from(json.image, 'base64'));

  // GL readback is bottom-up, so flip Y
  const getPixel = (x: number, y: number) => {
    const flippedY = height - 1 - y;
    const idx = (flippedY * width + x) * 4;
    return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
  };

  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  for (let i = 0; i < width * height; i++) {
    const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minG = Math.min(minG, g); maxG = Math.max(maxG, g);
    minB = Math.min(minB, b); maxB = Math.max(maxB, b);
  }

  return {
    center: getPixel(Math.floor(width/2), Math.floor(height/2)),
    sky: getPixel(0, 0),
    rangeR: [minR, maxR],
    rangeG: [minG, maxG],
    rangeB: [minB, maxB]
  };
}

// Step 5: Test with different frame counts
const W = 128, H = 128;

console.log('\n=== Testing with 1 frame ===');
const r1 = runAndAnalyze(1, W, H);
console.log(`Center: RGBA(${r1.center.join(', ')})`);
console.log(`Sky: RGBA(${r1.sky.join(', ')})`);
console.log(`R: ${r1.rangeR[0]}-${r1.rangeR[1]}, G: ${r1.rangeG[0]}-${r1.rangeG[1]}, B: ${r1.rangeB[0]}-${r1.rangeB[1]}`);

console.log('\n=== Testing with 5 frames ===');
const r5 = runAndAnalyze(5, W, H);
console.log(`Center: RGBA(${r5.center.join(', ')})`);
console.log(`Sky: RGBA(${r5.sky.join(', ')})`);
console.log(`R: ${r5.rangeR[0]}-${r5.rangeR[1]}, G: ${r5.rangeG[0]}-${r5.rangeG[1]}, B: ${r5.rangeB[0]}-${r5.rangeB[1]}`);

console.log('\n=== Testing with 30 frames ===');
const r30 = runAndAnalyze(30, W, H);
console.log(`Center: RGBA(${r30.center.join(', ')})`);
console.log(`Sky: RGBA(${r30.sky.join(', ')})`);
console.log(`R: ${r30.rangeR[0]}-${r30.rangeR[1]}, G: ${r30.rangeG[0]}-${r30.rangeG[1]}, B: ${r30.rangeB[0]}-${r30.rangeB[1]}`);

console.log('\n=== Testing with 120 frames (2 sec) ===');
const r120 = runAndAnalyze(120, W, H);
console.log(`Center: RGBA(${r120.center.join(', ')})`);
console.log(`Sky: RGBA(${r120.sky.join(', ')})`);
console.log(`R: ${r120.rangeR[0]}-${r120.rangeR[1]}, G: ${r120.rangeG[0]}-${r120.rangeG[1]}, B: ${r120.rangeB[0]}-${r120.rangeB[1]}`);

// Check for the "cube" symptom: if the image has very little variation in the center
// that means everything is hitting the volume bounding box
console.log('\n=== Center row scan at 120 frames (every 8px) ===');
{
  const cmd = `"${runnerPath}" "${bundlePath}" ${W} ${H} 120`;
  const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  const json = JSON.parse(result.trim());
  const pixels = new Uint8Array(Buffer.from(json.image, 'base64'));
  const getPixel = (x: number, y: number) => {
    const flippedY = H - 1 - y;
    const idx = (flippedY * W + x) * 4;
    return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
  };
  for (let x = 0; x < W; x += 8) {
    const p = getPixel(x, Math.floor(H/2));
    console.log(`  x=${x}: R=${(p[0]/255).toFixed(2)} G=${(p[1]/255).toFixed(2)} B=${(p[2]/255).toFixed(2)}`);
  }
}
