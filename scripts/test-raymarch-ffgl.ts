/**
 * Build the RAYMARCH_SHADER as an FFGL plugin and run it through the ffgl-runner.
 * This reproduces the exact code path used by Resolume/FFGL hosts.
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

console.log('Build dir:', buildDir);
console.log('Generated dir:', generatedDir);

// Step 1: Generate code
console.log('\n=== Step 1: Generate Code ===');
if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });

const cppGen = new CppGenerator();
const { code: cppCode, shaderFunctions } = cppGen.compile(RAYMARCH_SHADER, 'fn_main_cpu');
fs.writeFileSync(path.join(generatedDir, 'logic.cpp'), cppCode);
console.log('Generated logic.cpp');

const mslGen = new MslGenerator();
const { code: mslCode } = mslGen.compileLibrary(RAYMARCH_SHADER, shaderFunctions.map(s => s.id));
fs.writeFileSync(path.join(generatedDir, 'shaders.metal'), mslCode);
console.log('Generated shaders.metal');

// Step 2: Build ffgl-runner if needed
console.log('\n=== Step 2: Build ffgl-runner ===');
if (!fs.existsSync(runnerPath)) {
  const ffglSdkDir = path.join(repoRoot, 'modules/ffgl/source/lib');
  const cmd = generateCppCompileCmd({
    sourcePaths: [
      path.join(repoRoot, 'src/metal/ffgl-runner.mm'),
      path.join(repoRoot, 'src/metal/InteropTexture.m')
    ],
    outputPath: runnerPath,
    extraFlags: [`-I"${ffglSdkDir}"`, `-I"${path.join(repoRoot, 'tmp')}"`, '-fobjc-arc'],
    frameworks: ['Foundation', 'Cocoa', 'OpenGL', 'Metal', 'IOSurface', 'CoreVideo']
  });
  const scriptPath = path.join(buildDir, 'build_runner.sh');
  fs.writeFileSync(scriptPath, generateBuildScript([cmd]));
  fs.chmodSync(scriptPath, '755');
  console.log('Building runner...');
  execSync(scriptPath, { stdio: 'inherit' });
  console.log('Runner built.');
} else {
  console.log('Runner already exists, skipping build.');
}

// Step 3: Build FFGL plugin
console.log('\n=== Step 3: Build FFGL Plugin ===');
const steps: string[] = [];

// Compile Metal shaders
const shaderPath = path.join(generatedDir, 'shaders.metal');
steps.push(...generateMetalCompileCmds(shaderPath, buildDir));

// Compile FFGL plugin bundle
const name = 'Raymarcher';
const bundleName = name.replace(/\s+/g, '');
const bundlePath = path.join(buildDir, `${bundleName}.bundle`);

const textureInputCount = RAYMARCH_SHADER.inputs.filter(i => i.type === 'texture2d').length;
const internalResourceCount = RAYMARCH_SHADER.resources.filter(r => !r.isOutput).length;

console.log(`Texture inputs: ${textureInputCount}, Internal resources: ${internalResourceCount}`);

const ffglCmds = generateFFGLPluginCmds({
  outputPath: bundlePath,
  name,
  pluginId: 'RMRC',
  textureInputCount,
  internalResourceCount
});
steps.push(...ffglCmds);

// Copy metallib
const resourcesDir = path.join(bundlePath, 'Contents/Resources');
steps.push(`mkdir -p "${resourcesDir}"`);
steps.push(`cp "${path.join(buildDir, 'shaders.metallib')}" "${resourcesDir}/default.metallib"`);

const scriptPath = path.join(buildDir, 'build_raymarch.sh');
fs.writeFileSync(scriptPath, generateBuildScript(steps));
fs.chmodSync(scriptPath, '755');
console.log('Building plugin...');
execSync(scriptPath, { stdio: 'inherit' });
console.log('Plugin built at:', bundlePath);

// Step 4: Run through ffgl-runner
console.log('\n=== Step 4: Run FFGL Plugin ===');
const width = 128;
const height = 128;
const cmd = `"${runnerPath}" "${bundlePath}" ${width} ${height}`;
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

// Save raw PNG for inspection
const ppmPath = path.join(buildDir, 'raymarch_ffgl_output.ppm');
const ppmHeader = `P6\n${width} ${height}\n255\n`;
const ppmData = Buffer.alloc(width * height * 3);
for (let i = 0; i < width * height; i++) {
  ppmData[i * 3 + 0] = pixels[i * 4 + 0]; // R
  ppmData[i * 3 + 1] = pixels[i * 4 + 1]; // G
  ppmData[i * 3 + 2] = pixels[i * 4 + 2]; // B
}
fs.writeFileSync(ppmPath, Buffer.concat([Buffer.from(ppmHeader), ppmData]));
console.log('Saved PPM:', ppmPath);

// Sample some key pixels
const getPixel = (x: number, y: number) => {
  // Note: GL readback is bottom-up, so flip Y
  const flippedY = height - 1 - y;
  const idx = (flippedY * width + x) * 4;
  return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
};

const center = getPixel(width / 2, height / 2);
const corner = getPixel(0, 0);
const edge = getPixel(1, 1);

console.log(`Center pixel (${width/2}, ${height/2}): RGBA(${center.join(', ')})`);
console.log(`Corner pixel (0, 0): RGBA(${corner.join(', ')})`);
console.log(`Edge pixel (1, 1): RGBA(${edge.join(', ')})`);

// Check if all pixels are the same (flat output = something is wrong)
let minR = 255, maxR = 0;
let minG = 255, maxG = 0;
let minB = 255, maxB = 0;
for (let i = 0; i < width * height; i++) {
  const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
  minR = Math.min(minR, r); maxR = Math.max(maxR, r);
  minG = Math.min(minG, g); maxG = Math.max(maxG, g);
  minB = Math.min(minB, b); maxB = Math.max(maxB, b);
}
console.log(`R range: ${minR}-${maxR}`);
console.log(`G range: ${minG}-${maxG}`);
console.log(`B range: ${minB}-${maxB}`);

// Check if it looks like a sphere or a box
// Sample a row across the center
console.log('\nCenter row scan (normalized, every 8px):');
for (let x = 0; x < width; x += 8) {
  const p = getPixel(x, height / 2);
  console.log(`  x=${x}: R=${(p[0]/255).toFixed(2)} G=${(p[1]/255).toFixed(2)} B=${(p[2]/255).toFixed(2)}`);
}

// Check if the output texture format is BGRA
// If BGRA, B and R channels are swapped. Sky should be blue-ish.
// Sky color in RGBA: (0.55, 0.62, 0.78, 1.0) → ~(140, 158, 199)
// In BGRA: the bytes would be (199, 158, 140, 255)
const skyPixel = getPixel(0, 0); // Top-left should be sky
console.log(`\nSky pixel at top-left: RGBA(${skyPixel.join(', ')})`);
console.log(`Expected RGBA sky: ~(140, 158, 199, 255)`);
console.log(`If BGRA: bytes would be ~(199, 158, 140, 255)`);

if (skyPixel[0] > skyPixel[2]) {
  console.log('WARNING: Sky R > Sky B - possible BGRA/RGBA format mismatch!');
} else if (skyPixel[2] > skyPixel[0]) {
  console.log('OK: Sky B > Sky R - looks like correct RGBA order');
}
