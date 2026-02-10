/**
 * Metal shader compilation and execution utilities
 * Provides functions to compile .metal -> .metallib and run the Metal host program
 */

import { execSync, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import {
  MetalCompileResult,
  MetalRunResult,
  CppCompileOptions,
  FFGLCompilePaths,
  FFGLCompileOptions,
  generateMetalCompileCmds,
  generateCppCompileCmd,
  generateFFGLPluginCmds as generateFFGLPluginCmdsPure,
  generateBuildScript
} from './ffgl-packager';

export {
  MetalCompileResult,
  MetalRunResult,
  CppCompileOptions,
  FFGLCompilePaths,
  FFGLCompileOptions,
  generateMetalCompileCmds,
  generateCppCompileCmd,
  generateBuildScript
};

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

/**
 * Generate bash commands to compile the FFGL plugin bundle (Node version with defaults)
 */
export function generateFFGLPluginCmds(options: FFGLCompileOptions): string[] {
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

  return generateFFGLPluginCmdsPure({
    ...options,
    paths: options.paths || defaultPaths
  });
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


