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
  sourcePath: string;
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
  const { sourcePath, outputPath, frameworks = ['Metal', 'Foundation'], extraFlags = [] } = options;

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Build framework flags
  const frameworkFlags = frameworks.map(f => `-framework ${f}`).join(' ');

  // Compile with clang++
  const cmd = `clang++ -std=c++17 -O2 ${frameworkFlags} ${extraFlags.join(' ')} "${sourcePath}" -o "${outputPath}"`;
  execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return outputPath;
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
