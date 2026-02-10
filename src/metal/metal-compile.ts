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
 * Generate bash commands to compile a Metal shader file to a metallib
 */
export function generateMetalCompileCmds(shaderPath: string, outputDir: string): string[] {
  const shaderName = path.basename(shaderPath, '.metal');
  const airPath = path.join(outputDir, `${shaderName}.air`);
  const metallibPath = path.join(outputDir, `${shaderName}.metallib`);

  return [
    `# Compile Metal Shader: ${shaderName}`,
    `mkdir -p "${outputDir}"`,
    `xcrun -sdk macosx metal -c "${shaderPath}" -o "${airPath}"`,
    `xcrun -sdk macosx metallib "${airPath}" -o "${metallibPath}"`
  ];
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

  const cmds = generateMetalCompileCmds(shaderPath, outputDir);
  // Execute commands synchronously
  for (const cmd of cmds) {
    if (cmd.startsWith('#') || cmd.trim() === '') continue;
    execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  return { metallibPath, airPath };
}

export interface CppCompileOptions {
  sourcePaths: string[];
  outputPath: string;
  frameworks?: string[];
  extraFlags?: string[];
}

/**
 * Generate bash command to compile an Objective-C++ source file
 */
export function generateCppCompileCmd(options: CppCompileOptions): string {
  const { sourcePaths, outputPath, frameworks = ['Metal', 'Foundation'], extraFlags = [] } = options;
  const outputDir = path.dirname(outputPath);

  const frameworkFlags = frameworks.map(f => `-framework ${f}`).join(' ');
  const cmd = `clang++ -std=c++17 -O2 -D GL_SILENCE_DEPRECATION -D TARGET_MACOS=1 -x objective-c++ ${frameworkFlags} ${extraFlags.join(' ')} "${sourcePaths.join('" "')}" -o "${outputPath}"`;

  return [
    `# Compile C++ Host: ${path.basename(outputPath)}`,
    `mkdir -p "${outputDir}"`,
    cmd
  ].join('\n');
}

/**
 * Compile an Objective-C++ source file
 * @param options Compilation options
 * @returns Path to the compiled executable
 */
export function compileCppHost(options: CppCompileOptions): string {
  const cmdBlock = generateCppCompileCmd(options);
  const lines = cmdBlock.split('\n');
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;
    execSync(line, { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return options.outputPath;
}

export interface FFGLCompilePaths {
  ffglSdkDir: string;
  pluginSource: string;
  interopSource: string;
  additionalIncludes?: string[];
}

export interface FFGLCompileOptions {
  outputPath: string; // .../NanoFFGL.bundle
  name?: string;
  pluginId?: string;
  textureInputCount?: number;
  internalResourceCount?: number;
  paths?: FFGLCompilePaths;
}

/**
 * Generate bash commands to compile the FFGL plugin bundle
 */
export function generateFFGLPluginCmds(options: FFGLCompileOptions): string[] {
  const { outputPath } = options;

  // Default path resolution (backward compatibility / dev mode)
  const repoRoot = path.resolve(__dirname, '../..');
  const defaultPaths: FFGLCompilePaths = {
    ffglSdkDir: path.join(repoRoot, 'modules/ffgl/source/lib'),
    pluginSource: path.join(repoRoot, 'src/metal/ffgl-plugin.mm'),
    interopSource: path.join(repoRoot, 'src/metal/InteropTexture.m'),
    additionalIncludes: [
      path.join(repoRoot, 'src/metal'),
      path.join(repoRoot, 'src/metal/generated')
    ]
  };

  const finalPaths = options.paths || defaultPaths;
  const { ffglSdkDir, pluginSource, interopSource, additionalIncludes = [] } = finalPaths;

  const bundleName = options.name ? options.name.replace(/\s+/g, '') : path.basename(outputPath, '.bundle');
  const parentDir = path.dirname(outputPath);

  const actualBundlePath = path.join(parentDir, `${bundleName}.bundle`);
  const contentsDir = path.join(actualBundlePath, 'Contents');
  const macOsDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const binaryPath = path.join(macOsDir, bundleName);
  const infoPlistPath = path.join(contentsDir, 'Info.plist');

  const cmds: string[] = [];

  cmds.push(`# Build FFGL Plugin: ${bundleName}`);
  cmds.push(`rm -rf "${actualBundlePath}"`);
  cmds.push(`mkdir -p "${macOsDir}"`);
  cmds.push(`mkdir -p "${resourcesDir}"`);

  // Source files
  const sources = [
    `"${pluginSource}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGL.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLLog.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLThumbnailInfo.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLPluginInfo.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLPluginInfoData.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLPluginManager.cpp')}"`,
    `"${path.join(ffglSdkDir, 'ffgl/FFGLPluginSDK.cpp')}"`,
    `"${interopSource}"`,
  ];

  // Includes
  const includeFlags = [
    `-I"${ffglSdkDir}"`,
    `-I"${path.join(ffglSdkDir, 'ffgl')}"`,
    `-I"${path.join(ffglSdkDir, 'ffglex')}"`,
    `-I"${path.dirname(interopSource)}"`,
    ...additionalIncludes.map(p => `-I"${p}"`)
  ].join(' ');

  // Frameworks
  const frameworks = [
    'Cocoa', 'OpenGL', 'Metal', 'MetalKit', 'IOSurface', 'CoreVideo',
  ];
  const frameworkFlags = frameworks.map(f => `-framework ${f}`).join(' ');

  // Plugin properties
  const inputCount = options.textureInputCount ?? 0;
  let pluginType = 0; // Effect
  if (inputCount === 0) pluginType = 1; // Source
  if (inputCount === 1) pluginType = 0; // Effect
  if (inputCount >= 2) pluginType = 2; // Mixer

  const flags = [
    '-std=c++17',
    '-x objective-c++',
    '-bundle',
    '-fobjc-arc',
    '-D TARGET_MACOS=1',
    '-D FFGL_MACOS',
    '-D GL_SILENCE_DEPRECATION',
    '-Wl,-exported_symbol,_plugMain',
    '-g',
    options.name ? `-DPLUGIN_NAME='"${options.name}"'` : '',
    options.pluginId ? `-DPLUGIN_CODE='"${options.pluginId}"'` : '',
    `-DPLUGIN_TYPE=${pluginType}`,
    `-DMIN_INPUTS=${inputCount}`,
    `-DMAX_INPUTS=${inputCount}`,
    `-DINTERNAL_RESOURCE_COUNT=${options.internalResourceCount ?? 0}`,
  ].filter(f => f !== '').join(' ');

  // Compile
  cmds.push(`clang++ ${flags} ${includeFlags} ${frameworkFlags} ${sources.join(' ')} -o "${binaryPath}"`);

  // Codesign
  cmds.push(`codesign -s - "${binaryPath}"`);

  // Info.plist
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleExecutable</key>
\t<string>${bundleName}</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.nano.${bundleName}</string>
\t<key>CFBundleName</key>
\t<string>${bundleName}</string>
\t<key>CFBundlePackageType</key>
\t<string>BNDL</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.0</string>
\t<key>CFBundleVersion</key>
\t<string>1</string>
</dict>
</plist>`;

  cmds.push(`cat <<EOF > "${infoPlistPath}"
${plistContent}
EOF`);

  return cmds;
}

/**
 * Compile the FFGL plugin bundle
 * @param options Compilation options
 * @returns Path to the compiled bundle
 */
export function compileFFGLPlugin(options: FFGLCompileOptions): string {
  const cmds = generateFFGLPluginCmds(options);
  const fullScript = cmds.join('\n');

  // Execute via bash
  try {
    execSync(fullScript, { shell: '/bin/bash', cwd: process.cwd() });
  } catch (e: any) {
    console.error('FFGL COMPILATION ERROR DETAILS:');
    if (e.stdout) console.error('STDOUT:\n' + e.stdout.toString());
    if (e.stderr) console.error('STDERR:\n' + e.stderr.toString());
    throw e;
  }

  const bundleName = options.name ? options.name.replace(/\s+/g, '') : path.basename(options.outputPath, '.bundle');
  const parentDir = path.dirname(options.outputPath);
  return path.join(parentDir, `${bundleName}.bundle`);
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

/**
 * Generate a complete build script from a list of steps
 */
export function generateBuildScript(steps: string[]): string {
  return [
    '#!/bin/bash',
    'set -e',
    '',
    ...steps
  ].join('\n');
}
