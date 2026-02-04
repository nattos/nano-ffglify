// @ts-ignore
import intrinsicsRaw from './intrinsics.js?raw';

import { IRDocument, FunctionDef, Node, Edge } from '../ir/types';
import { reconstructEdges } from '../ir/utils';
import { WgslGenerator } from './wgsl-generator';
import { CompiledTaskFunction, CompiledInitFunction } from './jit-types';

export interface CompiledJitResult {
  init: CompiledInitFunction;
  task: CompiledTaskFunction;
}

/**
 * CPU JIT Compiler for WebGPU Host
 */
export class CpuJitCompiler {
  private ir?: IRDocument;

  compile(ir: IRDocument, entryPointId: string): CompiledJitResult {
    let body = this.compileToSource(ir, entryPointId);
    body = body.replace(`require('./intrinsics.js');`, intrinsicsRaw);

    let initBody = this.compileInitToSource(ir);
    initBody = initBody.replace(`require('./intrinsics.js');`, intrinsicsRaw);

    try {
      const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
      const task = new AsyncFunction('ctx', body);
      const init = new AsyncFunction('device', initBody);
      return { task, init };

    } catch (e) {
      console.error("JIT Compilation Failed:\n", body);
      // Log the full body for debugging ReferenceErrors
      // (This will show up in the test output)
      throw e;
    }
  }

  // ... (omitted)

  private hasResult(op: string): boolean {
    return !['call_func', 'branch', 'return', 'var_set', 'array_set', 'cmd_draw', 'cmd_resize_resource', 'log', 'buffer_store'].includes(op);
  }


  compileToSource(ir: IRDocument, entryPointId: string): string {
    this.ir = ir;
    const allFunctions = ir.functions;
    const func = allFunctions.find((f: any) => f.id === entryPointId);
    if (!func) throw new Error(`Entry point '${entryPointId}' not found`);

    const lines: string[] = [];

    lines.push(`"use strict";`);
    lines.push(`// Compiled Graph starting at: ${func.id}`);

    const sanitizeId = (id: string, type: 'input' | 'var' | 'func' = 'var') => {
      const clean = id.replace(/[^a-zA-Z0-9_]/g, '_');
      if (type === 'input') return `i_${clean}`;
      if (type === 'func') return `func_${clean}`;
      return `v_${clean}`;
    };
    const nodeResId = (id: string) => `n_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const funcName = (id: string) => sanitizeId(id, 'func');

    // Add common helpers for vector/matrix math
    this.emitIntrinsicHelpers(lines);
    lines.push('');

    // 1. Collect all reachable CPU functions and check for cycles
    const reachable = new Set<string>();
    const stack = new Set<string>();
    const checkCycles = (fid: string) => {
      if (stack.has(fid)) throw new Error(`Recursion detected: ${fid}`);
      if (reachable.has(fid)) return;
      reachable.add(fid);
      stack.add(fid);
      const f = allFunctions.find((func: FunctionDef) => func.id === fid);
      if (f) {
        f.nodes.forEach((n: Node) => {
          if (n.op === 'call_func' && typeof n.func === 'string') {
            const target = allFunctions.find((tf: FunctionDef) => tf.id === n.func);
            if (target && target.type === 'cpu') checkCycles(n.func);
          }
        });
      }
      stack.delete(fid);
    };
    checkCycles(func.id);

    // 2. Emit each reachable function as a nested JS function
    for (const fid of reachable) {
      const f = allFunctions.find((func: any) => func.id === fid);
      if (f) {
        this.emitFunction(f, lines, sanitizeId, nodeResId, funcName, allFunctions);
        lines.push('');
      }
    }

    // Map initial inputs to the entry function arguments
    lines.push('// Entry Point');
    lines.push('const entryInputs = {};');
    for (const input of func.inputs) {
      lines.push(`entryInputs['${input.id}'] = ctx.inputs.get('${input.id}');`);
    }
    lines.push(`return await ${funcName(func.id)}(ctx, entryInputs);`);

    return lines.join('\n');
  }

  private emitIntrinsicHelpers(lines: string[]) {
    lines.push(`
// Helper to ensure GPU Resource exists (simplistic version)
// In a real app this would call back to a robust resource manager or use a more advanced generated implementation.
// For this JIT, we assume intrinsics.js provides _ensureGpuResource and similar.
require('./intrinsics.js');
`);
  }

  compileInitToSource(ir: IRDocument): string {
    const lines: string[] = [];
    lines.push(`"use strict";`);
    this.emitIntrinsicHelpers(lines);

    // We need WgslGenerator to compile shaders
    // Since we are inside the browser (when JIT runs), we assume WgslGenerator is available
    // OR we pre-compile the WGSL strings HERE (in Node/Compiler) and embed them in the JS.
    // The latter is better as it keeps the generated JS dependency-free.

    // 1. Identify all shaders
    const shaders = new Map<string, any>(); // id -> { code, metadata }
    const renderPipelines = new Map<string, any>(); // key -> { codePair, metadata }

    // We use WgslGenerator to generate WGSL strings at compile time.
    const gen = new WgslGenerator();

    // Analyze graph for shader calls
    ir.functions.forEach(f => {
      f.nodes.forEach(n => {
        if (n.op === 'call_func' && typeof n['func'] === 'string') {
          const target = ir.functions.find(tf => tf.id === n['func']);
          if (target && target.type === 'shader') {
            if (!shaders.has(target.id)) {
              const res = gen.compileFunctions(ir.functions, target.id, { stage: 'compute', inputBinding: 1 }, ir);
              shaders.set(target.id, { code: WgslGenerator.resolveImports(res), metadata: res.metadata });
            }
          }
        }
        if (n.op === 'cmd_draw') {
          // For draw, we need unique pipeline keys
          const key = `${n['vertex']}|${n['fragment']}`;
          if (!renderPipelines.has(key)) {
            const vsRes = gen.compileFunctions(ir.functions, n['vertex'], { stage: 'vertex', inputBinding: 1 }, ir);
            const fsRes = gen.compileFunctions(ir.functions, n['fragment'], { stage: 'fragment', inputBinding: 1 }, ir);
            renderPipelines.set(key, {
              vsCode: WgslGenerator.resolveImports(vsRes),
              fsCode: WgslGenerator.resolveImports(fsRes),
              metadata: vsRes.metadata // Assume shared resource model
            });
          }
        }
      });
    });

    lines.push(`
      const pipelines = new Map(); // id -> GPUComputePipeline
      const renderPipelines = new Map(); // key -> GPURenderPipeline
      const pipelineMeta = new Map(); // id -> metadata
    `);

    // Emit shader compilation
    lines.push(`  // Pre-compile Shaders`);
    shaders.forEach((data, id) => {
      lines.push(`  {`);
      lines.push(`    const code = ${JSON.stringify(data.code)};`);
      lines.push(`    const module = device.createShaderModule({ code });`);
      lines.push(`    const pipeline = await device.createComputePipelineAsync({`);
      lines.push(`       layout: 'auto',`);
      lines.push(`       compute: { module, entryPoint: 'main' }`);
      lines.push(`    });`);
      lines.push(`    pipelines.set('${id}', pipeline);`);
      lines.push(`    pipelineMeta.set('${id}', ${JSON.stringify(data.metadata)});`);
      lines.push(`  }`);
    });

    // Emit Render pipelines
    renderPipelines.forEach((data, key) => {
      lines.push(`  {`);
      lines.push(`     const vsCode = ${JSON.stringify(data.vsCode)};`);
      lines.push(`     const fsCode = ${JSON.stringify(data.fsCode)};`);
      lines.push(`     const vsModule = device.createShaderModule({ code: vsCode });`);
      lines.push(`     const fsModule = device.createShaderModule({ code: fsCode });`);
      lines.push(`     const pipeline = await device.createRenderPipelineAsync({`);
      lines.push(`        layout: 'auto',`);
      lines.push(`        vertex: { module: vsModule, entryPoint: 'main' },`);
      lines.push(`        fragment: { module: fsModule, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] }`); // Format hardcoded for now
      lines.push(`     });`);
      lines.push(`     renderPipelines.set('${key}', pipeline);`);
      lines.push(`     pipelineMeta.set('${key}', ${JSON.stringify(data.metadata)});`);
      lines.push(`  }`);
    });

    lines.push(`
      return {
        async executeShader(funcId, dim, args, resources) {
           const pipeline = pipelines.get(funcId);
           if (!pipeline) throw new Error("Pipeline not found: " + funcId);
           const meta = pipelineMeta.get(funcId);

           // 1. Inputs
           let inputBind = null;
           // TODO: Implement Input Buffer packing
           // For now assuming no inputs or handled via _ensureBuffer

           // 2. Resources
           const entries = [];
           // Flatten resource bindings
           for (const [resId, binding] of Object.entries(meta.resourceBindings)) {
               const state = resources.get(resId);
               if (!state) continue;

               // Ensure GPU resource exists (Helper in intrinsics)
               _ensureGpuResource(device, state);

               if (state.def.type === 'texture2d') {
                   entries.push({ binding, resource: state.gpuTexture.createView() });
               } else {
                   entries.push({ binding, resource: { buffer: state.gpuBuffer } });
               }
           }

           // If inputs, bind them (TODO)

           const bindGroup = device.createBindGroup({
               layout: pipeline.getBindGroupLayout(0),
               entries
           });

           const encoder = device.createCommandEncoder();
           const pass = encoder.beginComputePass();
           pass.setPipeline(pipeline);
           pass.setBindGroup(0, bindGroup);
           pass.dispatchWorkgroups(dim[0], dim[1], dim[2]);
           pass.end();
           device.queue.submit([encoder.finish()]);
        },

        async executeDraw(targetId, vertexId, fragmentId, count, pipelineDef, resources) {
            const key = \`\${vertexId}|\${fragmentId}\`;
            const pipeline = renderPipelines.get(key);
            // ... implementation similar to webgpu-executor ...
        }
      };
    `);

    return lines.join('\n');
  }

  private emitFunction(f: FunctionDef, lines: string[], sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[]) {
    lines.push(`async function ${funcName(f.id)}(ctx, args) {`);

    // Unpack args into local vars
    for (const input of f.inputs) {
      lines.push(`  let ${sanitizeId(input.id, 'input')} = args['${input.id}'];`);
    }

    // Local Variables
    for (const v of f.localVars) {
      const init = v.initialValue !== undefined ? JSON.stringify(v.initialValue) : '0';
      lines.push(`  let ${sanitizeId(v.id, 'var')} = ${init};`);
    }

    const edges = reconstructEdges(f);

    const resultNodes = f.nodes.filter(n => this.hasResult(n.op));
    for (const n of resultNodes) {
      lines.push(`  let ${nodeResId(n.id)};`);
    }

    const emittedPure = new Set<string>();
    const emitPure = (nodeId: string) => {
      if (emittedPure.has(nodeId)) return;
      const node = f.nodes.find(n => n.id === nodeId);
      if (!node || this.isExecutable(node.op)) return;

      // Mark as emitted to prevent recursion during dependency emission
      emittedPure.add(nodeId);

      // Emit data dependencies first
      edges.filter(e => e.to === nodeId && e.type === 'data').forEach(edge => {
        emitPure(edge.from);
      });

      lines.push(`  ${nodeResId(node.id)} = ${this.compileExpression(node, f, sanitizeId, nodeResId, funcName, allFunctions, true, emitPure, edges)};`);
    };

    // Compile node logic
    lines.push(`  // Pure Nodes (lazy emission)`);

    // Execution Chain
    const entryNodes = f.nodes.filter(n => {
      const hasExecIn = edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op);
    });

    for (const entry of entryNodes) {
      this.emitChain('  ', entry, f, lines, new Set(), sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    }

    lines.push(`  return 0; // Default return`);
    lines.push(`}`);
  }

  private emitChain(indent: string, node: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], emitPure: (id: string) => void, edges: Edge[]) {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    // Ensure dependencies are ready
    edges.filter(e => e.to === node.id && e.type === 'data').forEach(e => {
      emitPure(e.from);
    });

    lines.push(`${indent}// ${node.op} (${node.id})`);

    // Emit the node's action
    switch (node.op) {
      case 'call_func':
        {
          const targetId = node['func'];
          const target = allFunctions.find(t => t.id === targetId);
          if (target) {
            const args: string[] = [];
            target.inputs.forEach(inp => {
              const argEdge = edges.find(e => e.to === node.id && e.portIn === inp.id);
              if (argEdge) {
                args.push(`'${inp.id}': ${nodeResId(argEdge.from)}`);
              } else {
                // Check literal override in node props?
                // For now, default 0
                args.push(`'${inp.id}': ${node[inp.id] ?? 0}`);
              }
            });
            const argsObj = `{ ${args.join(', ')} }`;

            if (target.type === 'shader') {
              // Call GPU Dispatch via Globals
              // Assuming 1D dispatch for simplicity or derived from args
              const dim = `[1, 1, 1]`; // Placeholder
              lines.push(`${indent}await ctx.globals.dispatch('${targetId}', ${dim}, ${argsObj});`);
            } else {
              // CPU Call
              lines.push(`${indent}await ${funcName(targetId)}(ctx, ${argsObj});`);
            }
          }
        }
        break;
      case 'branch':
        {
          const condEdge = edges.find(e => e.to === node.id && e.portIn === 'condition');
          const cond = condEdge ? nodeResId(condEdge.from) : (node['condition'] ?? 'false');
          lines.push(`${indent}if (${cond}) {`);

          const trueEdge = edges.find(e => e.from === node.id && e.portOut === 'true' && e.type === 'execution');
          if (trueEdge) {
            const next = func.nodes.find(n => n.id === trueEdge.to);
            if (next) this.emitChain(indent + '  ', next, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
          }

          lines.push(`${indent}} else {`);

          const falseEdge = edges.find(e => e.from === node.id && e.portOut === 'false' && e.type === 'execution');
          if (falseEdge) {
            const next = func.nodes.find(n => n.id === falseEdge.to);
            if (next) this.emitChain(indent + '  ', next, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
          }
          lines.push(`${indent}}`);
          return; // Branch handles its own flow
        }
      case 'return':
      case 'func_return':
        {
          const val = this.resolveArg(node, 'value', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
          // If fallback to 'val' property is needed (resolveArg doesn't automatically check aliases unless handled)
          // Actually resolveArg checks specific key. If key mismatch...
          // We can check if 'value' resolved to '0' (default) and try 'val'?
          // Or just call resolveArg for 'val' if node['val'] exists?
          // Since resolveArg is complex, let's try 'value' first.
          // BUT test-runner uses 'val'.
          // resolveArg logic:
          // const edge = edges.find(e => e.portIn === key...)
          // if (node[key] !== undefined) ...

          let result = '0';
          // Try 'value' (standard)
          if (edges.some(e => e.to === node.id && e.portIn === 'value') || node['value'] !== undefined) {
            result = this.resolveArg(node, 'value', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
          }
          // Try 'val' (alias)
          else if (edges.some(e => e.to === node.id && e.portIn === 'val') || node['val'] !== undefined) {
            result = this.resolveArg(node, 'val', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
          }

          lines.push(`${indent}return ${result};`);
        }
        break;
      case 'var_set':
        {
          const varId = node['var'];
          const valEdge = edges.find(e => e.to === node.id && e.portIn === 'val');
          const val = valEdge ? nodeResId(valEdge.from) : (node['val'] ?? '0');
          // If local var
          if (func.localVars.some(v => v.id === varId)) {
            lines.push(`${indent}${sanitizeId(varId, 'var')} = ${val};`);
          } else {
            // Global context var (not supported in strict pure mode, but maybe?)
            lines.push(`${indent}// Set global ${varId} ignored in pure CPU JIT for now`);
          }
        }
        break;
      case 'cmd_draw':
        {
          // Call via Globals
          const args = `{}`; // Draw args?
          lines.push(`${indent}await ctx.globals.draw('${node['target']}', '${node['vertex']}', '${node['fragment']}', ${node['count'] ?? 3}, {});`);
        }
        break;
      case 'cmd_resize_resource':
        {
          const resId = node['resource'];
          const sizeEdge = edges.find(e => e.to === node.id && e.portIn === 'size');
          const size = sizeEdge ? nodeResId(sizeEdge.from) : (JSON.stringify(node['size']) ?? '100');
          const format = node['format'] ? `'${node['format']}'` : 'undefined';
          lines.push(`${indent}ctx.globals.resize('${resId}', ${size}, ${format});`);
        }
        break;
      case 'log':
        {
          const msgEdge = edges.find(e => e.to === node.id && e.portIn === 'message');
          const msg = msgEdge ? nodeResId(msgEdge.from) : `'${node['message']}'`;
          lines.push(`${indent}ctx.globals.log(${msg});`);
        }
        break;
      case 'buffer_store':
        {
          const bufId = node['buffer'];
          const idxEdge = edges.find(e => e.to === node.id && e.portIn === 'index');
          const idx = idxEdge ? nodeResId(idxEdge.from) : (node['index'] ?? 0);
          const valEdge = edges.find(e => e.to === node.id && e.portIn === 'value');
          const val = valEdge ? nodeResId(valEdge.from) : (node['value'] ?? 0);

          lines.push(`${indent}_buffer_store(ctx.resources, '${bufId}', ${idx}, ${val});`);
        }
        break;
      case 'array_set':
        {
          const arrEdge = edges.find(e => e.to === node.id && e.portIn === 'array');
          let arrVal;
          if (arrEdge) {
            emitPure(arrEdge.from);
            arrVal = nodeResId(arrEdge.from);
          } else {
            arrVal = sanitizeId(node['array'], 'var');
          }

          const idxEdge = edges.find(e => e.to === node.id && e.portIn === 'index');
          if (idxEdge) emitPure(idxEdge.from);
          const idx = idxEdge ? nodeResId(idxEdge.from) : (node['index'] ?? 0);

          const valEdge = edges.find(e => e.to === node.id && e.portIn === 'value');
          if (valEdge) emitPure(valEdge.from);
          const val = valEdge ? nodeResId(valEdge.from) : (node['value'] ?? 0);

          lines.push(`${indent}${arrVal}[${idx}] = ${val};`);
        }
        break;
    }

    // Continue chain
    const nextEdges = edges.filter(e => e.from === node.id && e.type === 'execution' && e.portOut !== 'true' && e.portOut !== 'false');
    for (const edge of nextEdges) {
      const nextNode = func.nodes.find(n => n.id === edge.to);
      if (nextNode) {
        this.emitChain(indent, nextNode, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
      }
    }
  }

  private compileExpression(node: Node, func: FunctionDef, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], forceEmit: boolean = false, emitPure: (id: string) => void, edges: Edge[]): string {
    if (!forceEmit && this.hasResult(node.op)) {
      emitPure(node.id);
      return nodeResId(node.id);
    }

    const a = (k = 'a') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    const b = (k = 'b') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
    const val = (k = 'val') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);

    switch (node.op) {
      case 'var_get': {
        const varId = node['var'];
        if (func.localVars.some(v => v.id === varId)) return sanitizeId(varId, 'var');
        if (func.inputs.some(i => i.id === varId)) return sanitizeId(varId, 'input');
        if (func.inputs.some(i => i.id === varId)) return sanitizeId(varId, 'input');
        return `_getVar(ctx, '${varId}')`;
      }
      case 'buffer_load': {
        const bufId = node['buffer'];
        const idxEdge = edges.find(e => e.to === node.id && e.portIn === 'index');
        const idx = idxEdge ? nodeResId(idxEdge.from) : (node['index'] ?? 0);
        return `_buffer_load(ctx.resources, '${bufId}', ${idx})`;
      }
      case 'texture_load': {
        const texId = node['tex'];
        const coords = this.resolveArg(node, 'coords', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `((coords) => {
          const res = ctx.resources.get('${texId}');
          if (!res) return [0, 0, 0, 0];
          const x = Math.floor(coords[0]), y = Math.floor(coords[1]);
          if (x < 0 || x >= res.width || y < 0 || y >= res.height) return [0, 0, 0, 0];
          return res.data[y * res.width + x] || [0, 0, 0, 0];
        })(${coords})`;
      }
      case 'texture_sample': {
        const texId = node['tex'];
        const uv = (node['uv'] !== undefined) ? this.resolveArg(node, 'uv', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges) : this.resolveArg(node, 'coords', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `((uv) => {
          const res = ctx.resources.get('${texId}');
          if (!res) return [0, 0, 0, 0];
          // Simple nearest for now
          const w = res.width;
          const h = res.height;
          const u = uv[0] - Math.floor(uv[0]);
          const v = uv[1] - Math.floor(uv[1]);
          const x = Math.floor(u * w);
          const y = Math.floor(v * h);
          const val = res.data[y * w + x];
          return val !== undefined ? val : [0, 0, 0, 0];
        })(${uv})`;
      }

      case 'literal': return JSON.stringify(node['val']);
      case 'loop_index': return `loop_${node['loop'].replace(/[^a-zA-Z0-9_]/g, '_')}`;

      // Basic Math (Unary)
      case 'math_neg': return `_applyUnary(${val()}, v => -v)`;
      case 'math_sign': return `_applyUnary(${val()}, Math.sign)`;
      case 'math_tan': return `_applyUnary(${val()}, Math.tan)`;
      case 'math_asin': return `_applyUnary(${val()}, Math.asin)`;
      case 'math_acos': return `_applyUnary(${val()}, Math.acos)`;
      case 'math_atan': return `_applyUnary(${val()}, Math.atan)`;
      case 'math_sinh': return `_applyUnary(${val()}, Math.sinh)`;
      case 'math_cosh': return `_applyUnary(${val()}, Math.cosh)`;
      case 'math_tanh': return `_applyUnary(${val()}, Math.tanh)`;
      case 'math_sqrt': return `_applyUnary(${val()}, Math.sqrt)`;
      case 'math_exp': return `_applyUnary(${val()}, Math.exp)`;
      case 'math_log': return `_applyUnary(${val()}, Math.log)`;
      case 'math_ceil': return `_applyUnary(${val()}, Math.ceil)`;
      case 'math_floor': return `_applyUnary(${val()}, Math.floor)`;
      case 'math_trunc': return `_applyUnary(${val()}, Math.trunc)`;
      case 'math_fract': return `_applyUnary(${val()}, v => v - Math.floor(v))`;
      case 'math_is_nan': return `_applyUnary(${val()}, v => isNaN(v) ? 1.0 : 0.0)`;
      case 'math_is_inf': return `_applyUnary(${val()}, v => (!isFinite(v) && !isNaN(v)) ? 1.0 : 0.0)`;
      case 'math_is_finite': return `_applyUnary(${val()}, v => isFinite(v) ? 1.0 : 0.0)`;
      case 'math_flush_subnormal': return `_applyUnary(${val()}, v => Math.abs(v) < 1.17549435e-38 ? 0.0 : v)`;
      case 'math_mantissa': return `_applyUnary(${val()}, v => {
        if (v === 0 || !isFinite(v)) return v;
        const exp = Math.floor(Math.log2(Math.abs(v))) + 1;
        return v * Math.pow(2, -exp);
      })`;
      case 'math_exponent': return `_applyUnary(${val()}, v => {
        if (v === 0 || !isFinite(v)) return 0;
        return Math.floor(Math.log2(Math.abs(v))) + 1;
      })`;


      // Constructors
      case 'float4': return `[${a('x')}, ${a('y')}, ${a('z')}, ${a('w')}]`;
      case 'float3': return `[${a('x')}, ${a('y')}, ${a('z')}]`;
      case 'float2': return `[${a('x')}, ${a('y')}]`;
      case 'float': return `${a('val')}`;
      case 'int': return `Math.floor(${a('val')})`;
      case 'bool': return `!!${a('val')}`;

      // Math Ops (Use intrinsics)
      case 'math_add': return `(${a()} + ${b()})`;
      case 'math_sub': return `(${a()} - ${b()})`;
      case 'math_mul': return `(${a()} * ${b()})`;
      case 'math_div': return `(${a()} / ${b()})`;
      case 'math_sin': return `Math.sin(${a()})`;
      case 'math_cos': return `Math.cos(${a()})`;
      case 'math_max': return `Math.max(${a()}, ${b()})`;
      case 'math_min': return `Math.min(${a()}, ${b()})`;
      case 'math_abs': return `Math.abs(${a()})`;
      case 'math_mix': return `_mix(${a('a')}, ${b('b')}, ${val('factor')})`;
      case 'math_mod': return `(${a()} % ${b()})`;
      case 'math_clamp': return `Math.max(${b('min')}, Math.min(${val('max')}, ${a('val')}))`;

      case 'math_pow': return `_applyBinary(${a()}, ${b()}, Math.pow)`;
      case 'math_atan2': return `_applyBinary(${a()}, ${b()}, Math.atan2)`;
      case 'math_mad': {
        const cVal = this.resolveArg(node, 'c', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `_applyBinary(_applyBinary(${a()}, ${b()}, (x, y) => x * y), ${cVal}, (x, y) => x + y)`;
      }
      case 'math_step': return `_applyBinary(${this.resolveArg(node, 'edge', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}, ${val()}, (e, x) => x < e ? 0 : 1)`;
      case 'math_smoothstep': {
        const e0 = this.resolveArg(node, 'edge0', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const e1 = this.resolveArg(node, 'edge1', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        return `((v, edge0, edge1) => _applyUnary(_applyBinary(_applyBinary(v, edge0, (x, e) => (x - e)), _applyBinary(edge1, edge0, (e1, e0) => (e1 - e0)), (n, d) => Math.max(0, Math.min(1, n / d))), t => t * t * (3 - 2 * t)))(${val()}, ${e0}, ${e1})`;
      }

      // Comparison
      case 'math_gt': return `_applyBinary(${a()}, ${b()}, (x, y) => x > y ? 1.0 : 0.0)`;
      case 'math_lt': return `_applyBinary(${a()}, ${b()}, (x, y) => x < y ? 1.0 : 0.0)`;
      case 'math_ge': return `_applyBinary(${a()}, ${b()}, (x, y) => x >= y ? 1.0 : 0.0)`;
      case 'math_le': return `_applyBinary(${a()}, ${b()}, (x, y) => x <= y ? 1.0 : 0.0)`;
      case 'math_eq': return `_applyBinary(${a()}, ${b()}, (x, y) => x === y ? 1.0 : 0.0)`;
      case 'math_neq': return `_applyBinary(${a()}, ${b()}, (x, y) => x !== y ? 1.0 : 0.0)`;

      // Logic
      case 'math_and': return `_applyBinary(${a()}, ${b()}, (x, y) => (x && y) ? 1.0 : 0.0)`;
      case 'math_or': return `_applyBinary(${a()}, ${b()}, (x, y) => (x || y) ? 1.0 : 0.0)`;
      case 'math_xor': return `_applyBinary(${a()}, ${b()}, (x, y) => (x ^ y) ? 1.0 : 0.0)`;
      case 'math_not': return `_applyUnary(${val()}, v => (!v) ? 1.0 : 0.0)`;

      // Casts
      case 'static_cast_float': return `Number(${val()})`;
      case 'static_cast_int': return `(${val()} | 0)`;
      case 'static_cast_uint': return `Math.abs(Math.trunc(${val()}))`;
      case 'static_cast_bool': return `Boolean(${val()})`;


      // Vector Ops (Intrinsics)
      case 'vec_add': return `_vec_add(${a()}, ${b()})`;
      case 'vec_sub': return `_vec_sub(${a()}, ${b()})`;
      case 'vec_mul': return `_vec_mul(${a()}, ${b()})`;
      case 'vec_div': return `_vec_div(${a()}, ${b()})`;
      case 'vec_scale': return `_vec_scale(${a()}, ${b('scale')})`;
      case 'vec_length': return `_vec_len(${a()})`;
      case 'vec_normalize': return `_vec_norm(${a()})`;
      case 'vec_mix': return `_vec_mix(${a()}, ${b()}, ${val('factor')})`;
      case 'vec_dot': return `_vec_dot(${a()}, ${b()})`;
      case 'vec_swizzle': {
        const vec = this.resolveArg(node, 'vec', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
        const channels = node['channels'] || node['swizzle'] || 'x';
        const map: any = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
        const idxs = channels.split('').map((c: string) => map[c]);
        if (idxs.length === 1) return `${vec}[${idxs[0]}]`;
        return `[${idxs.map((i: number) => `${vec}[${i}]`).join(', ')}]`;
      }

      case 'color_mix': {
        const dst = a();
        const src = b();
        const tEdge = edges.find(e => e.to === node.id && e.portIn === 't' && e.type === 'data');
        if (tEdge || (node['t'] !== undefined)) {
          const t = this.resolveArg(node, 't', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges);
          return `_applyBinary(_applyBinary(${dst}, _applyBinary(1, ${t}, (x, y) => x - y), (x, y) => x * y), _applyBinary(${src}, ${t}, (x, y) => x * y), (x, y) => x + y)`;
        }
        return `((d, s) => {
            if (!Array.isArray(s) || !Array.isArray(d)) return s;
            const out = new Array(4);
            const sa = s[3] === undefined ? 1.0 : s[3];
            const da = d[3] === undefined ? 1.0 : d[3];
            const ra = sa + da * (1 - sa);
            for(let i=0; i<3; i++) out[i] = ra < 1e-6 ? 0 : (s[i]*sa + d[i]*da*(1-sa))/ra;
            out[3] = ra;
            return out;
        })(${dst}, ${src})`;
      }

      // Matrix
      case 'float3x3':
      case 'float4x4': {
        const size = node.op === 'float3x3' ? 9 : 16;
        if (node['vals'] !== undefined || edges.some(e => e.to === node.id && e.portIn === 'vals')) {
          return a('vals');
        }
        const keys = size === 9 ? ['m00', 'm10', 'm20', 'm01', 'm11', 'm21', 'm02', 'm12', 'm22'] :
          ['m00', 'm10', 'm20', 'm30', 'm01', 'm11', 'm21', 'm31', 'm02', 'm12', 'm22', 'm32', 'm03', 'm13', 'm23', 'm33'];
        return `[${keys.map(k => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)).join(', ')}]`;
      }
      case 'mat_identity': {
        const size = Number(node['size'] || 4);
        const arr = new Array(size * size).fill(0);
        for (let i = 0; i < size; i++) arr[i * size + i] = 1;
        return JSON.stringify(arr);
      }
      case 'mat_mul': return `_mat_mul(${a()}, ${b()})`;
      case 'mat_extract': return `(${a()}[${b('index')}])`;
      case 'mat_transpose': {
        const m = a();
        return `((m) => {
          const dim = Math.sqrt(m.length);
          const out = new Array(m.length);
          for(let r=0; r<dim; r++) for(let c=0; c<dim; c++) out[c*dim + r] = m[r*dim + c];
          return out;
        })(${m})`;
      }
      case 'mat_inverse': return a('val');

      // Quaternions
      case 'quat': return `[${a('x')}, ${a('y')}, ${a('z')}, ${a('w')}]`;
      case 'quat_identity': return `[0, 0, 0, 1]`;
      case 'quat_mul': return `_quat_mul(${a()}, ${b()})`;
      case 'quat_rotate': {
        const v = a('v');
        const q = a('q');
        return `((v, q) => {
          const [vx, vy, vz] = v;
          const [qx, qy, qz, qw] = q;
          const ix = qw * vx + qy * vz - qz * vy;
          const iy = qw * vy + qz * vx - qx * vz;
          const iz = qw * vz + qx * vy - qy * vx;
          const iw = -qx * vx - qy * vy - qz * vz;
          return [
            ix * qw + iw * -qx + iy * -qz - iz * -qy,
            iy * qw + iw * -qy + iz * -qx - ix * -qz,
            iz * qw + iw * -qz + ix * -qy - iy * -qx
          ];
        })(${v}, ${q})`;
      }
      case 'quat_slerp': return `_quat_slerp(${a()}, ${b()}, ${this.resolveArg(node, 't', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)})`;
      case 'quat_to_float4x4': return `_quat_to_mat4(${this.resolveArg(node, 'q', func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)})`;

      // Constants
      case 'math_pi': return `Math.PI`;
      case 'math_e': return `Math.E`;

      // ... more vector ops

      case 'vec_make': {
        // Gather all args
        // Assuming x,y,z,w ports
        const args = ['x', 'y', 'z', 'w'].map(k => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)).join(', ');

        return `[${args}]`;
      }

      case 'struct_construct': {
        const keys = new Set<string>();
        edges.filter(e => e.to === node.id).forEach(e => keys.add(e.portIn));
        Object.keys(node).forEach(k => {
          if (!['id', 'op', 'type', 'comment', 'metadata', 'const_data'].includes(k)) keys.add(k);
        });
        const props = Array.from(keys).map(k => {
          return `${k}: ${this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, emitPure, edges)}`;
        });
        return `{ ${props.join(', ')} }`;
      }
      case 'struct_extract': return `${val('struct')}.${node['field']}`;

      case 'array_construct': {
        if (node['length'] !== undefined && node['fill'] !== undefined) {
          return `new Array(${val('length')}).fill(${val('fill')})`;
        }
        return '[]'; // TODO: explicit items
      }
      case 'array_extract': return `${val('array')}[${val('index')}]`;
      case 'array_length': return `${val('array')}.length`;

      case 'vec_get_element': return `${val('vec')}[${val('index')}]`;
      case 'vec_split': return '0'; // Should be handled by data flow logic accessing this node? No, usually split has multiple outputs.
      // In this simple graph model, split might just be a logical node where downstream nodes access "split.x" etc.
      // But here we are compiling expressions returning a SINGLE value.
      // If split is used, the downstream node probably edges from "split" with a "fromPort".
      // We need to handle port access in `resolveArg`.

      default: return '0';
    }
  }

  private resolveArg(node: Node, key: string, func: FunctionDef, sanitizeId: (id: string) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], emitPure: (id: string) => void, edges: Edge[]): string {
    const edge = edges.find(e => e.to === node.id && e.portIn === key);
    if (edge) {
      // If the source is 'vec_split', we might need to access a component
      const srcNode = func.nodes.find(n => n.id === edge.from);
      if (srcNode && srcNode.op === 'vec_split') {
        // ensure split is emitted
        emitPure(srcNode.id);
        // access component by port name (e.g., 'x', 'y')
        return `${nodeResId(srcNode.id)}[${['x', 'y', 'z', 'w'].indexOf(edge.portOut)}]`;
      }
      return nodeResId(edge.from);
    }
    // Check for literal override
    if (node[key] !== undefined) return JSON.stringify(node[key]);
    return '0';
  }

  private hasResult(op: string): boolean {
    return !['call_func', 'branch', 'return', 'func_return', 'var_set', 'array_set', 'cmd_draw', 'cmd_resize_resource', 'log', 'buffer_store'].includes(op);
  }

  private isExecutable(op: string): boolean {
    return ['call_func', 'branch', 'return', 'func_return', 'var_set', 'array_set', 'cmd_draw', 'cmd_resize_resource', 'log', 'buffer_store'].includes(op);
  }
}
