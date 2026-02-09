/**
 * Metal shader compilation and execution utilities
 * Provides functions to compile .metal -> .metallib and run the Metal host program
 */

import { execSync, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface MetalCompileResult {
  metallibPath: string;
  airPath: string;
}

export interface MetalRunResult {
  result: number;
}

/**
 * Compile a Metal shader file to a metallib
 * @param shaderPath Path to the .metal source file
 * @param outputDir Directory to place compiled artifacts
 * @returns Paths to the compiled .air and .metallib files
 */
export function compileMetalShader(shaderPath: string, outputDir: string): MetalCompileResult {
  const shaderName = path.basename(shaderPath, '.metal');
  const airPath = path.join(outputDir, `${shaderName}.air`);
  const metallibPath = path.join(outputDir, `${shaderName}.metallib`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Step 1: Compile .metal -> .air
  execSync(`xcrun -sdk macosx metal -c "${shaderPath}" -o "${airPath}"`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Step 2: Link .air -> .metallib
  execSync(`xcrun -sdk macosx metallib "${airPath}" -o "${metallibPath}"`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return { metallibPath, airPath };
}

export interface CppCompileOptions {
  sourcePaths: string[];
  outputPath: string;
  frameworks?: string[];
  extraFlags?: string[];
}

/**
 * Compile an Objective-C++ source file
 * @param options Compilation options
 * @returns Path to the compiled executable
 */
export function compileCppHost(options: CppCompileOptions): string {
  const { sourcePaths, outputPath, frameworks = ['Metal', 'Foundation'], extraFlags = [] } = options;

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Build framework flags
  const frameworkFlags = frameworks.map(f => `-framework ${f}`).join(' ');

  // Compile with clang++
  const cmd = `clang++ -std=c++17 -O2 -D GL_SILENCE_DEPRECATION -D TARGET_MACOS=1 -x objective-c++ ${frameworkFlags} ${extraFlags.join(' ')} "${sourcePaths.join('" "')}" -o "${outputPath}"`;
  execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return outputPath;
}

export interface FFGLCompileOptions {
  outputPath: string;
  name?: string;
  pluginId?: string;
  textureInputCount?: number;
}

/**
 * Compile the FFGL plugin bundle
 * @param options Compilation options
 * @returns Path to the compiled bundle
 */
export function compileFFGLPlugin(options: FFGLCompileOptions): string {
  const { outputPath } = options;
  // outputPath is .../NanoFFGL.bundle

  // Clean up existing bundle if it exists
  if (fs.existsSync(outputPath)) {
    fs.rmSync(outputPath, { recursive: true, force: true });
  }

  // Create Bundle Structure
  const contentsDir = path.join(outputPath, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');

  fs.mkdirSync(macOsDir, { recursive: true });

  // Paths
  const repoRoot = path.resolve(__dirname, '../..');
  const ffglSdkDir = path.join(repoRoot, 'modules/ffgl/source/lib');
  const tmpDir = path.join(repoRoot, 'tmp');
  const srcMetalDir = path.join(repoRoot, 'src/metal');

  // Binary Name
  const bundleName = options.name ? options.name.replace(/\s+/g, '') : path.basename(outputPath, '.bundle');
  const actualOutputPath = options.name ? path.join(path.dirname(outputPath), `${bundleName}.bundle`) : outputPath;

  // Clean up existing bundle if it exists (at the potentially new path)
  if (actualOutputPath !== outputPath && fs.existsSync(actualOutputPath)) {
    fs.rmSync(actualOutputPath, { recursive: true, force: true });
  }

  // Reload dirs based on actualOutputPath
  const actualContentsDir = path.join(actualOutputPath, 'Contents');
  const actualMacOsDir = path.join(actualContentsDir, 'MacOS');
  if (!fs.existsSync(actualMacOsDir)) {
    fs.mkdirSync(actualMacOsDir, { recursive: true });
  }

  const binaryPath = path.join(actualMacOsDir, bundleName);

  // Source files
  const sources = [
    path.join(srcMetalDir, 'ffgl-plugin.mm'),
    path.join(ffglSdkDir, 'FFGLSDK.cpp'),
    path.join(tmpDir, 'AAPLOpenGLMetalInteropTexture.m'),
  ];

  // Includes
  const includeFlags = [
    `-I"${ffglSdkDir}"`,
    `-I"${tmpDir}"`,
    `-I"${srcMetalDir}"`,
    `-I"${path.join(srcMetalDir, 'generated')}"`,
  ].join(' ');

  // Frameworks
  const frameworks = [
    'Cocoa',
    'OpenGL',
    'Metal',
    'MetalKit',
    'IOSurface',
    'CoreVideo',
  ];
  const frameworkFlags = frameworks.map(f => `-framework ${f}`).join(' ');

  // Plugin Type and Input Constraints
  const inputCount = options.textureInputCount ?? 0;
  let pluginType = 1; // Default to Effect if unknown
  if (inputCount === 0) pluginType = 0; // Source
  if (inputCount === 1) pluginType = 1; // Effect
  if (inputCount >= 2) pluginType = 2; // Mixer

  // Compiler flags
  const flags = [
    '-std=c++17',
    '-x objective-c++',
    '-bundle',
    '-fobjc-arc', // Required for AAPLOpenGLMetalInteropTexture.m
    '-D TARGET_MACOS=1',
    '-D GL_SILENCE_DEPRECATION',
    '-g',         // Debug info
    options.name ? `-DPLUGIN_NAME='"${options.name}"'` : '',
    options.pluginId ? `-DPLUGIN_CODE='"${options.pluginId}"'` : '',
    `-DPLUGIN_TYPE=${pluginType}`,
    `-DMIN_INPUTS=${inputCount}`,
    `-DMAX_INPUTS=${inputCount}`,
  ].filter(f => f !== '').join(' ');

  const cmd = `clang++ ${flags} ${includeFlags} ${frameworkFlags} "${sources.join('" "')}" -o "${binaryPath}"`;

  // console.log('Compiling FFGL plugin:', cmd);
  try {
    execSync(cmd, {
      encoding: 'utf-8',
      stdio: 'inherit',
    });
  } catch (e) {
    console.error('Compilation failed');
    throw e;
  }

  // Code Sign (Required for ARM64)
  try {
    execSync(`codesign -s - "${binaryPath}"`, { stdio: 'ignore' });
  } catch (e) {
    console.warn('Failed to codesign bundle:', e);
  }

  // Write Info.plist
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>${bundleName}</string>
	<key>CFBundleIdentifier</key>
	<string>com.nano.${bundleName}</string>
	<key>CFBundleName</key>
	<string>${bundleName}</string>
	<key>CFBundlePackageType</key>
	<string>BNDL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
</dict>
</plist>`;

  fs.writeFileSync(path.join(actualContentsDir, 'Info.plist'), plistContent.trim());

  return actualOutputPath;
}

/**
 * Run the Metal host program and parse its JSON output
 * @param executablePath Path to the compiled host executable
 * @param metallibPath Path to the compiled metallib
 * @returns Parsed result from the program output
 */
export function runMetalProgram(executablePath: string, metallibPath: string): MetalRunResult {
  const output = execSync(`"${executablePath}" "${metallibPath}"`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const parsed = JSON.parse(output.trim());
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed as MetalRunResult;
}

/**
 * Get a temporary directory for Metal build artifacts
 */
export function getMetalBuildDir(): string {
  const dir = path.join(os.tmpdir(), 'nano-ffglify-metal-build');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
