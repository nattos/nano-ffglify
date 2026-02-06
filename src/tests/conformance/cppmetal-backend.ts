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

    // 1. Generate C++ code
    const generator = new CppGenerator();
    const { code, resourceIds } = generator.compile(ir, entryPoint);

    // 2. Write generated code
    const generatedCodePath = path.join(buildDir, 'generated_code.cpp');
    fs.writeFileSync(generatedCodePath, code);

    // 3. Find harness source
    const harnessPath = path.resolve(__dirname, '../../metal/cpp-harness.mm');
    const executablePath = path.join(buildDir, 'cpp-runner');

    // 4. Compile harness + generated code
    const compileCmd = `clang++ -std=c++17 -O2 -I"${buildDir}" -framework Foundation "${harnessPath}" -o "${executablePath}"`;
    try {
      execSync(compileCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      throw new Error(`C++ compilation failed: ${e.stderr || e.message}`);
    }

    // 5. Prepare resource sizes as arguments
    const resourceSizes = ir.resources.map(r => {
      if (r.type === 'buffer') {
        const size = r.size && typeof r.size === 'object' && 'value' in r.size ? r.size.value : 100;
        return String(size);
      }
      return '0';
    });

    // 6. Run executable
    let output: string;
    try {
      output = execSync(`"${executablePath}" ${resourceSizes.join(' ')}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      throw new Error(`C++ execution failed: ${e.stderr || e.message}`);
    }

    // 7. Parse JSON output
    const result = JSON.parse(output.trim());

    // 8. Update EvaluationContext with results
    result.resources.forEach((res: { data: number[] }, i: number) => {
      const resDef = ir.resources[i];
      const resId = resDef?.id;
      if (resId) {
        const state = ctx.resources.get(resId);
        if (state) {
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
    });
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await CppMetalBackend.createContext(ir, inputs);
    await CppMetalBackend.run(ctx, entryPoint);
    return ctx;
  },
};
