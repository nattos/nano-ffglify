/**
 * CppMetal TestBackend
 * Compiles IR to C++, runs native executable, parses JSON output
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { RuntimeValue, EvaluationContext } from '../../interpreter/context';
import { IRDocument } from '../../ir/types';
import { TestBackend } from './types';
import { CppGenerator } from '../../metal/cpp-generator';
import { MslGenerator } from '../../metal/msl-generator';
import { makeResourceStates } from '../../runtime/resources';

function getCppMetalBuildDir(): string {
  // Use unique subdirectory for each call to avoid parallel test conflicts
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(os.tmpdir(), 'nano-ffglify-cppmetal-build', uniqueId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export const CppMetalBackend: TestBackend = {
  name: 'CppMetal',

  createContext: async (ir: IRDocument, inputs: Map<string, RuntimeValue> = new Map()) => {
    return new EvaluationContext(ir, inputs);
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    const ir = ctx.ir;
    const buildDir = getCppMetalBuildDir();

    // 1. Generate C++ code for CPU functions
    const generator = new CppGenerator();
    const { code, resourceIds, shaderFunctions } = generator.compile(ir, entryPoint);

    // 2. Write generated C++ code
    const generatedCodePath = path.join(buildDir, 'generated_code.cpp');
    fs.writeFileSync(generatedCodePath, code);

    // 3. Generate MSL for shader functions if any exist
    let metallibPath = '';
    if (shaderFunctions.length > 0) {
      const mslGen = new MslGenerator();

      // Generate MSL for all shader functions in one go
      const { code: mslCode } = mslGen.compileLibrary(ir, shaderFunctions.map(s => s.id));

      // Write MSL source
      const mslPath = path.join(buildDir, 'shaders.metal');
      fs.writeFileSync(mslPath, mslCode);

      // Compile to .metallib
      metallibPath = path.join(buildDir, 'shaders.metallib');
      const airPath = path.join(buildDir, 'shaders.air');
      try {
        // First compile to AIR
        execSync(`xcrun -sdk macosx metal -c "${mslPath}" -o "${airPath}"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Then link to metallib
        execSync(`xcrun -sdk macosx metallib "${airPath}" -o "${metallibPath}"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e: any) {
        console.error('MSL source:', mslCode);
        throw new Error(`Metal shader compilation failed: ${e.stderr || e.message}`);
      }
    }

    // 4. Find harness source
    const harnessPath = path.resolve(__dirname, '../../metal/cpp-harness.mm');
    const executablePath = path.join(buildDir, 'cpp-runner');

    // 5. Compile harness + generated code (link Metal framework for dispatch)
    const compileCmd = `clang++ -std=c++17 -O2 -I"${buildDir}" -framework Foundation -framework Metal "${harnessPath}" -o "${executablePath}"`;
    try {
      execSync(compileCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      throw new Error(`C++ compilation failed: ${e.stderr || e.message}`);
    }

    // 6. Prepare resource specs as arguments
    const resourceSpecs = ir.resources.map(r => {
      if (r.type === 'texture2d') {
        const size = r.size && typeof r.size === 'object' && 'value' in r.size ? r.size.value : [1, 1];
        const [w, h] = Array.isArray(size) ? size : [size, 1];
        return `T:${w}:${h}`;
      }
      if (r.type === 'buffer') {
        const size = r.size && typeof r.size === 'object' && 'value' in r.size ? r.size.value : 100;
        return String(size);
      }
      return '0';
    });

    // 7. Build input args from ctx.inputs
    const inputArgs: string[] = [];
    for (const [name, value] of ctx.inputs) {
      const numVal = typeof value === 'number' ? value : Array.isArray(value) ? value[0] : 0;
      inputArgs.push('-i', `${name}:${numVal}`);
    }

    // 8. Run executable with optional metallib path, inputs, and resource specs
    const metallibArg = metallibPath ? `"${metallibPath}" ` : '';
    const inputArgsStr = inputArgs.length > 0 ? inputArgs.join(' ') + ' ' : '';
    let output: string;
    try {
      output = execSync(`"${executablePath}" ${metallibArg}${inputArgsStr}${resourceSpecs.join(' ')}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024, // 64MB for large texture outputs
      });
    } catch (e: any) {
      throw new Error(`C++ execution failed: ${e.stderr || e.message}`);
    }

    // 9. Parse JSON output
    const result = JSON.parse(output.trim());

    // 10. Update EvaluationContext with results
    result.resources.forEach((res: { type?: string; width?: number; height?: number; data: number[] }, i: number) => {
      const resDef = ir.resources[i];
      const resId = resDef?.id;
      if (resId) {
        const state = ctx.resources.get(resId);
        if (state) {
          // Update width/height from native output (may have changed via cmd_resize_resource)
          if (res.width !== undefined) state.width = res.width;
          if (res.height !== undefined) state.height = res.height;

          if (res.type === 'texture' || resDef.type === 'texture2d') {
            // Texture data: flat RGBA floats → restructure into [[r,g,b,a], ...] nested arrays
            const chunks: number[][] = [];
            for (let j = 0; j < res.data.length; j += 4) {
              chunks.push(res.data.slice(j, j + 4));
            }
            state.data = chunks as any;
          } else {
            // For typed buffers (float2/3/4), restructure flat data into nested arrays
            const dataType = resDef?.dataType;
            if (dataType === 'float4' || dataType === 'float3' || dataType === 'float2') {
              const stride = dataType === 'float4' ? 4 : dataType === 'float3' ? 3 : 2;
              const chunks: number[][] = [];
              for (let j = 0; j < res.data.length; j += stride) {
                chunks.push(res.data.slice(j, j + stride));
              }
              state.data = chunks as any;
            } else {
              state.data = res.data;
            }
          }
        }
      }
    });
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await CppMetalBackend.createContext(ir, inputs);
    await CppMetalBackend.run(ctx, entryPoint);
    return ctx;
  },
};
