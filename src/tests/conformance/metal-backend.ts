/**
 * Metal Test Backend
 * Generates MSL, compiles to Metal library, executes on GPU, reads back results.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IRDocument, ResourceDef } from '../../ir/types';
import { validateIR } from '../../ir/validator';
import { EvaluationContext, RuntimeValue } from '../../interpreter/context';
import { TestBackend } from './types';
import { MslGenerator } from '../../metal/msl-generator';

// Build directory for Metal GPU tests
function getMetalBuildDir(): string {
  const baseDir = path.join(os.tmpdir(), 'nano-ffglify-metal-build');
  const uniqueDir = path.join(baseDir, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  if (!fs.existsSync(uniqueDir)) {
    fs.mkdirSync(uniqueDir, { recursive: true });
  }
  return uniqueDir;
}

// Compile the harness once
let harnessPath: string | null = null;
function getMetalHarness(): string {
  if (harnessPath && fs.existsSync(harnessPath)) {
    return harnessPath;
  }

  const srcDir = path.resolve(__dirname, '../../metal');
  const harnessSrc = path.join(srcDir, 'metal-gpu-harness.mm');
  const buildDir = path.join(os.tmpdir(), 'nano-ffglify-metal-harness');

  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }

  harnessPath = path.join(buildDir, 'metal-gpu-harness');

  // Only compile if needed
  if (!fs.existsSync(harnessPath)) {
    const compileCmd = `clang++ -std=c++17 -framework Metal -framework Foundation "${harnessSrc}" -o "${harnessPath}"`;
    try {
      execSync(compileCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      throw new Error(`Metal harness compilation failed: ${e.stderr || e.message}`);
    }
  }

  return harnessPath;
}

export const MetalBackend: TestBackend = {
  name: 'Metal',

  createContext: async (ir: IRDocument, inputs?: Map<string, RuntimeValue>) => {
    // Validate IR
    const errors = validateIR(ir);
    const criticalErrors = errors.filter(e => e.severity === 'error');
    if (criticalErrors.length > 0) {
      throw new Error(`IR Validation Failed:\n${criticalErrors.map(e => e.message).join('\n')}`);
    }

    const ctx = new EvaluationContext(ir, inputs || new Map());

    // Store IR reference for later use
    (ctx as any)._ir = ir;

    return ctx;
  },

  run: async (ctx: EvaluationContext, entryPoint: string) => {
    const ir = (ctx as any)._ir as IRDocument;
    if (!ir) throw new Error('[MetalBackend] IR not found on context');

    const buildDir = getMetalBuildDir();
    const harness = getMetalHarness();

    // 1. Generate MSL
    const generator = new MslGenerator();
    const result = generator.compile(ir, entryPoint);
    const mslCode = result.code;

    // 2. Write .metal source file
    const sourceFile = path.join(buildDir, 'generated.metal');
    fs.writeFileSync(sourceFile, mslCode);

    // 3. Build buffer definitions for command line
    // Get binding indices from generator metadata
    const resourceBindings = result.metadata.resourceBindings || new Map<string, number>();
    const bufferArgs: string[] = [];
    const textureArgs: string[] = [];
    for (const res of ir.resources) {
      const binding = resourceBindings.get(res.id) ?? 0;
      if (res.type === 'buffer') {
        const state = ctx.resources.get(res.id);
        if (state) {
          const data = state.data || [];
          const dataStr = '[' + data.map(v => String(v)).join(',') + ']';
          // Calculate actual float count based on element type
          const elemCount = state.width || 1;
          const dataType = (res as any).dataType || 'float';
          let floatsPerElem = 1;
          if (dataType.includes('4') || dataType === 'quat') floatsPerElem = 4;
          else if (dataType.includes('3')) floatsPerElem = 3;
          else if (dataType.includes('2')) floatsPerElem = 2;
          const totalFloats = elemCount * floatsPerElem;
          // Format: bufferId:binding:size:data
          bufferArgs.push(`${res.id}:${binding}:${totalFloats}:${dataStr}`);
        }
      } else if (res.type === 'texture2d') {
        const state = ctx.resources.get(res.id);
        if (state) {
          const width = state.width || 1;
          const height = state.height || 1;
          const data = state.data || [];
          const dataStr = '[' + data.map(v => String(v)).join(',') + ']';
          // Get sampler settings from resource definition
          const sampler = (res as any).sampler || { filter: 'linear', wrap: 'clamp' };
          const filter = sampler.filter || 'linear';
          const wrap = sampler.wrap || 'clamp';
          // Format: texId:binding:width:height:filter:wrap:data
          textureArgs.push(`${res.id}:${binding}:${width}:${height}:${filter}:${wrap}:${dataStr}`);
        }
      }
    }

    // 4. Execute harness
    const globalsSize = result.metadata.globalBufferSize;
    // Pass buffers first, then textures with -t prefix
    const allArgs = [...bufferArgs, ...textureArgs.map(t => `-t ${t}`)];
    const cmd = `"${harness}" "${sourceFile}" ${globalsSize} ${allArgs.join(' ')}`;

    let output: string;
    try {
      output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      const stderr = e.stderr || '';
      const stdout = e.stdout || '';
      throw new Error(`Metal execution failed: ${stderr}\n${stdout}`);
    }

    // 5. Parse JSON output
    let jsonResult: any;
    try {
      jsonResult = JSON.parse(output.trim());
    } catch (e) {
      throw new Error(`Failed to parse Metal output: ${output}`);
    }

    if (jsonResult.error) {
      throw new Error(`Metal error: ${jsonResult.error}`);
    }

    // 6. Update EvaluationContext with results
    for (const res of jsonResult.resources || []) {
      const state = ctx.resources.get(res.id);
      if (state) {
        state.data = res.data;
      }
    }
  },

  execute: async (ir: IRDocument, entryPoint: string, inputs: Map<string, RuntimeValue> = new Map()) => {
    const ctx = await MetalBackend.createContext(ir, inputs);
    await MetalBackend.run(ctx, entryPoint);
    return ctx;
  },
};
