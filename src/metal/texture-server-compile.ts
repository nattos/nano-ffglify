/**
 * Build infrastructure for the texture server binary.
 * Compiles the Objective-C++ sources, caches via source hash, and provides
 * a helper to spawn the server process and wait for readiness.
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SOURCE_FILES = [
  'texture-server.mm',
  'texture-server-ws.mm',
  'texture-server-main.mm',
];

const HEADER_FILES = [
  'texture-server.h',
];

const BUILD_DIR = path.join(os.tmpdir(), 'nano-ffglify-texture-server');
const BINARY_NAME = 'texture-server';

function getSourceDir(): string {
  return path.resolve(__dirname);
}

function computeSourceHash(): string {
  const hash = crypto.createHash('sha256');
  const srcDir = getSourceDir();
  for (const file of [...SOURCE_FILES, ...HEADER_FILES]) {
    const filePath = path.join(srcDir, file);
    if (fs.existsSync(filePath)) {
      hash.update(fs.readFileSync(filePath));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Compile the texture server binary if needed (cached by source hash).
 * Returns the path to the compiled binary.
 */
export function getTextureServerBinary(): string {
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }

  const binaryPath = path.join(BUILD_DIR, BINARY_NAME);
  const hashPath = path.join(BUILD_DIR, `${BINARY_NAME}.hash`);
  const currentHash = computeSourceHash();

  // Check if cached binary is up to date
  if (fs.existsSync(binaryPath) && fs.existsSync(hashPath)) {
    const cachedHash = fs.readFileSync(hashPath, 'utf-8').trim();
    if (cachedHash === currentHash) {
      return binaryPath;
    }
  }

  // Compile
  const srcDir = getSourceDir();
  const sourceArgs = SOURCE_FILES.map(f => `"${path.join(srcDir, f)}"`).join(' ');

  const compileCmd = [
    'clang++',
    '-std=c++17',
    '-O2',
    '-x objective-c++',
    '-fobjc-arc',
    `-I"${srcDir}"`,
    '-framework Foundation',
    '-framework Network',
    sourceArgs,
    `-o "${binaryPath}"`,
  ].join(' ');

  try {
    execSync(compileCmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const stderr = e.stderr || '';
    throw new Error(`Texture server compilation failed:\n${stderr}`);
  }

  // Write hash
  fs.writeFileSync(hashPath, currentHash);

  return binaryPath;
}

export interface TextureServerProcess {
  process: ChildProcess;
  port: number;
  kill: () => void;
}

/**
 * Spawn the texture server and wait for it to become ready.
 * Returns the child process and the actual port it's listening on.
 */
export async function startTextureServer(
  port: number = 0,
  options?: { expiry?: number }
): Promise<TextureServerProcess> {
  const binaryPath = getTextureServerBinary();

  const args: string[] = [];
  if (port > 0) {
    args.push('--port', String(port));
  }
  if (options?.expiry !== undefined) {
    args.push('--expiry', String(options.expiry));
  }

  const child = spawn(binaryPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Collect stderr for diagnostics
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Wait for readiness signal on stdout
  const actualPort = await new Promise<number>((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Texture server failed to start within 10s. stderr: ${stderr}`));
    }, 10000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // Look for readiness JSON
      const lines = stdout.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.includes('"status"')) {
          try {
            const obj = JSON.parse(trimmed);
            if (obj.status === 'listening' && typeof obj.port === 'number') {
              clearTimeout(timeout);
              resolve(obj.port);
              return;
            }
          } catch {
            // Not valid JSON yet, keep reading
          }
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn texture server: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(`Texture server exited with code ${code}. stderr: ${stderr}`));
      }
    });
  });

  return {
    process: child,
    port: actualPort,
    kill: () => {
      child.kill('SIGTERM');
    },
  };
}
