import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { compileMetalShader, compileCppHost, runMetalProgram, getMetalBuildDir } from '../metal/metal-compile';

describe('Metal Sanity', () => {
  it('should compile and run a minimal Metal compute shader', async () => {
    const metalDir = path.resolve(__dirname, '../metal');
    const buildDir = getMetalBuildDir();

    // 1. Compile Metal shader
    const shaderPath = path.join(metalDir, 'metal-sanity.metal');
    const { metallibPath } = compileMetalShader(shaderPath, buildDir);
    expect(metallibPath).toBeDefined();

    // 2. Compile C++ host
    const hostSource = path.join(metalDir, 'metal-runner.mm');
    const hostExecutable = path.join(buildDir, 'metal-runner');
    compileCppHost({
      sourcePath: hostSource,
      outputPath: hostExecutable,
    });

    // 3. Run and verify
    const result = runMetalProgram(hostExecutable, metallibPath);
    expect(result.result).toBe(123);
  });
});
