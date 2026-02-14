/**
 * Build the PARTICLE_SHADER as an FFGL plugin and run it through the ffgl-runner.
 */
import { CppGenerator } from '../src/metal/cpp-generator';
import { MslGenerator } from '../src/metal/msl-generator';
import { PARTICLE_SHADER } from '../src/domain/example-ir';
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

console.log('Build dir:', buildDir);
console.log('Generated dir:', generatedDir);

// Step 1: Generate code
console.log('\n=== Step 1: Generate Code ===');
if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });

const cppGen = new CppGenerator();
const { code: cppCode, shaderFunctions } = cppGen.compile(PARTICLE_SHADER, 'fn_main_cpu');
fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);
console.log('Generated logic.cpp');
console.log('Shader functions:', shaderFunctions.map(s => s.id));

const mslGen = new MslGenerator();
const stages = new Map<string, 'compute' | 'vertex' | 'fragment'>();
shaderFunctions.forEach(f => { if (f.stage) stages.set(f.id, f.stage); });
const { code: mslCode } = mslGen.compileLibrary(PARTICLE_SHADER, shaderFunctions.map(s => s.id), { stages });
fs.writeFileSync(path.join(generatedDir, 'shaders.metal'), mslCode);
console.log('Generated shaders.metal');

// Print resource info
console.log('Resources:', PARTICLE_SHADER.resources.map(r => r.id + '(' + r.type + ', output=' + r.isOutput + ')'));
console.log('Inputs:', PARTICLE_SHADER.inputs.map(i => i.id + '(' + (i.type || 'float') + ')'));
console.log('Structs:', PARTICLE_SHADER.structs?.map(s => s.id + '(' + s.members.map((m: any) => m.id + ':' + m.type).join(', ') + ')'));
console.log('Internal resource count:', PARTICLE_SHADER.resources.filter(r => !r.isOutput).length);

// Step 2: Build ffgl-runner (force rebuild to pick up any changes)
console.log('\n=== Step 2: Build ffgl-runner ===');
// Always rebuild runner to pick up any changes
if (fs.existsSync(runnerPath)) {
  fs.unlinkSync(runnerPath);
}
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
const runnerScriptPath = path.join(buildDir, 'build_runner.sh');
fs.writeFileSync(runnerScriptPath, generateBuildScript([runnerCmd]));
fs.chmodSync(runnerScriptPath, '755');
console.log('Building runner...');
execSync(runnerScriptPath, { stdio: 'inherit' });
console.log('Runner built.');

// Step 3: Build FFGL plugin
console.log('\n=== Step 3: Build FFGL Plugin ===');
const steps: string[] = [];

// Compile Metal shaders
const shaderPath = path.join(generatedDir, 'shaders.metal');
steps.push(...generateMetalCompileCmds(shaderPath, buildDir));

// Compile FFGL plugin bundle
const name = 'Particles';
const bundleName = name.replace(/\s+/g, '');
const bundlePath = path.join(buildDir, `${bundleName}.bundle`);

const textureInputCount = PARTICLE_SHADER.inputs.filter(i => i.type === 'texture2d').length;
const internalResourceCount = PARTICLE_SHADER.resources.filter(r => !r.isOutput).length;

console.log(`Texture inputs: ${textureInputCount}, Internal resources: ${internalResourceCount}`);

const ffglCmds = generateFFGLPluginCmds({
  outputPath: bundlePath,
  name,
  pluginId: 'PTCL',
  textureInputCount,
  internalResourceCount
});
steps.push(...ffglCmds);

// Copy metallib
const resourcesDir = path.join(bundlePath, 'Contents/Resources');
steps.push(`mkdir -p "${resourcesDir}"`);
steps.push(`cp "${path.join(buildDir, 'shaders.metallib')}" "${resourcesDir}/default.metallib"`);

const scriptPath = path.join(buildDir, 'build_particle.sh');
fs.writeFileSync(scriptPath, generateBuildScript(steps));
fs.chmodSync(scriptPath, '755');
console.log('Building plugin...');
execSync(scriptPath, { stdio: 'inherit' });
console.log('Plugin built at:', bundlePath);

// Step 4: Run through ffgl-runner (multiple frames for particle evolution)
console.log('\n=== Step 4: Run FFGL Plugin ===');
const width = 256;
const height = 256;
const numFrames = 10;
const cmd = `"${runnerPath}" "${bundlePath}" ${width} ${height} ${numFrames}`;
console.log('Running:', cmd);
const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
const json = JSON.parse(result.trim());

console.log('Success:', json.success);
console.log('Name:', json.name);
console.log('ID:', json.id);
console.log('Size:', json.width, 'x', json.height);

// Step 5: Decode and analyze the image
console.log('\n=== Step 5: Analyze Output ===');
const buffer = Buffer.from(json.image, 'base64');
const pixels = new Uint8Array(buffer);

// Save PPM for inspection
const ppmPath = path.join(buildDir, 'particle_ffgl_output.ppm');
const ppmHeader = `P6\n${width} ${height}\n255\n`;
const ppmData = Buffer.alloc(width * height * 3);
for (let i = 0; i < width * height; i++) {
  ppmData[i * 3 + 0] = pixels[i * 4 + 0];
  ppmData[i * 3 + 1] = pixels[i * 4 + 1];
  ppmData[i * 3 + 2] = pixels[i * 4 + 2];
}
fs.writeFileSync(ppmPath, Buffer.concat([Buffer.from(ppmHeader), ppmData]));
console.log('Saved PPM:', ppmPath);

// Pixel analysis
const getPixel = (x: number, y: number) => {
  const flippedY = height - 1 - y;
  const idx = (flippedY * width + x) * 4;
  return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
};

const center = getPixel(width / 2, height / 2);
console.log(`Center pixel: RGBA(${center.join(', ')})`);

// Check pixel ranges
let minR = 255, maxR = 0;
let minG = 255, maxG = 0;
let minB = 255, maxB = 0;
let nonBlackCount = 0;
for (let i = 0; i < width * height; i++) {
  const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
  minR = Math.min(minR, r); maxR = Math.max(maxR, r);
  minG = Math.min(minG, g); maxG = Math.max(maxG, g);
  minB = Math.min(minB, b); maxB = Math.max(maxB, b);
  if (r > 0 || g > 0 || b > 0) nonBlackCount++;
}
console.log(`R range: ${minR}-${maxR}`);
console.log(`G range: ${minG}-${maxG}`);
console.log(`B range: ${minB}-${maxB}`);
console.log(`Non-black pixels: ${nonBlackCount} / ${width * height} (${(100 * nonBlackCount / (width * height)).toFixed(1)}%)`);

if (nonBlackCount === 0) {
  console.log('\n*** OUTPUT IS ENTIRELY BLACK ***');
  console.log('Possible causes:');
  console.log('  - Particle simulation not running (wrong particle_count?)');
  console.log('  - Draw call not executing');
  console.log('  - Time/delta too small (check /1000 conversion)');
}
