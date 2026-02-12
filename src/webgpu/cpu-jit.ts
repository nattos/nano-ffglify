// @ts-ignore
import intrinsicsRaw from './intrinsics.js?raw';

import { IRDocument, FunctionDef, Node, Edge } from '../ir/types';
import { reconstructEdges } from '../ir/utils';
import { CompilationMetadata, WgslGenerator } from './wgsl-generator';
import { CompiledTaskFunction, CompiledInitFunction } from './jit-types';
import { precomputeShaderInfo, precomputeResourceLayout } from './precompute';
import { inferFunctionTypes, InferredTypes } from '../ir/validator';

export interface CompiledJitResult {
  initCode: string;
  taskCode: string;
  init: CompiledInitFunction;
  task: CompiledTaskFunction;
}

/**
 * CPU JIT Compiler for WebGPU Host
 */
export class CpuJitCompiler {
  private ir?: IRDocument;

  compile(ir: IRDocument, entryPointId: string): CompiledJitResult {
    const rawBody = this.compileToSource(ir, entryPointId);
    const body = rawBody.replace(`require('./intrinsics.js');`, intrinsicsRaw);

    const rawInitBody = this.compileInitToSource(ir);
    const initBody = rawInitBody.replace(`require('./intrinsics.js');`, intrinsicsRaw);

    try {
      const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
      const task = new AsyncFunction('ctx', body);
      const init = new AsyncFunction('device', initBody);
      return { taskCode: rawBody, initCode: rawInitBody, task, init };

    } catch (e) {
      console.error("JIT Compilation Failed:\n", body);
      // Log the full body for debugging ReferenceErrors
      // (This will show up in the test output)
      throw e;
    }
  }

  private hasResult(op: string): boolean {
    if (op.startsWith('math_') || op.startsWith('vec_') || op.startsWith('mat_') || op.startsWith('quat_')) return true;
    const valueOps = [
      'float', 'int', 'uint', 'bool', 'literal', 'loop_index',
      'float2', 'float3', 'float4',
      'float3x3', 'float4x4',
      'mat_mul', 'mat_extract',
      'static_cast_float', 'static_cast_int', 'static_cast_uint', 'static_cast_bool',
      'struct_construct', 'struct_extract',
      'array_construct', 'array_extract', 'array_length', 'array_set',
      'var_get', 'buffer_load', 'texture_load', 'texture_sample', 'call_func', 'vec_swizzle',
      'color_mix', 'vec_get_element', 'quat',
      'resource_get_size', 'resource_get_format', 'builtin_get', 'const_get'
    ];
    return valueOps.includes(op);
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
        const inferredTypes = inferFunctionTypes(f, ir);
        this.emitFunction(f, lines, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes);
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
    const shaders = new Map<string, { code: string; metadata: CompilationMetadata }>();
    const renderPipelines = new Map<string, { vsCode: string, fsCode: string, metadata: CompilationMetadata, vertexId: Node }>();

    // We use WgslGenerator to generate WGSL strings at compile time.
    const gen = new WgslGenerator();

    // Analyze graph for shader calls
    ir.functions.forEach(f => {
      f.nodes.forEach(n => {
        if ((n.op === 'call_func' || n.op === 'cmd_dispatch') && typeof n['func'] === 'string') {
          const target = ir.functions.find(tf => tf.id === n['func']);
          if (target && target.type === 'shader') {
            if (!shaders.has(target.id)) {
              const res = gen.compile(ir, target.id, { stage: 'compute', inputBinding: 1 });
              shaders.set(target.id, { code: WgslGenerator.resolveImports(res), metadata: res.metadata });
            }
          }
        }
        if (n.op === 'cmd_draw') {
          // For draw, we need unique pipeline keys
          const key = `${n['vertex']}|${n['fragment']}`;
          if (!renderPipelines.has(key)) {
            const vsRes = gen.compile(ir, n['vertex'], { stage: 'vertex', inputBinding: 1 });
            const fsRes = gen.compile(ir, n['fragment'], { stage: 'fragment', inputBinding: 1 });
            renderPipelines.set(key, {
              vsCode: WgslGenerator.resolveImports(vsRes),
              fsCode: WgslGenerator.resolveImports(fsRes),
              metadata: vsRes.metadata,
              vertexId: n['vertex']
            });
          }
        }
      });
    });

    lines.push(`
      const pipelines = new Map(); // id -> GPUComputePipeline
      const renderPipelines = new Map(); // key -> GPURenderPipeline
      const precomputedInfos = new Map(); // id -> precomputedInfo
      const resourceInfos = new Map(); // id -> PrecomputedResourceInfo
    `);

    // Emit Resource Precomputations
    lines.push(`  // Precompute Resource Layouts`);
    ir.resources.forEach(res => {
      const info = precomputeResourceLayout(res);
      lines.push(`  resourceInfos.set('${res.id}', ${JSON.stringify(info)});`);
    });
    // Also precompute for texture inputs
    ir.inputs.forEach(inp => {
      if (inp.type === 'texture2d') {
        const info = precomputeResourceLayout({ ...inp, type: 'texture2d' });
        lines.push(`  resourceInfos.set('${inp.id}', ${JSON.stringify(info)});`);
      }
    });
    lines.push('');

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

      const precomputed = precomputeShaderInfo(data.metadata, ir.structs || []);
      lines.push(`    precomputedInfos.set('${id}', ${JSON.stringify(precomputed)});`);
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

      const precomputed = precomputeShaderInfo(data.metadata, ir.structs || []);
      lines.push(`    precomputedInfos.set('${data.vertexId}', ${JSON.stringify(precomputed)});`);
      lines.push(`  }`);
    });

    lines.push(`
      return _createExecutor(device, pipelines, precomputedInfos, renderPipelines, resourceInfos);
    `);

    return lines.join('\n');
  }

  private emitFunction(f: FunctionDef, lines: string[], sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], inferredTypes: InferredTypes) {
    lines.push(`async function ${funcName(f.id)} (ctx, args) {
      `);

    // Unpack args into local vars
    for (const input of f.inputs) {
      lines.push(`  let ${sanitizeId(input.id, 'input')
        } = args['${input.id}']; `);
    }

    // Local Variables
    for (const v of f.localVars) {
      const init = v.initialValue !== undefined ? JSON.stringify(v.initialValue) : '0';
      lines.push(`  let ${sanitizeId(v.id, 'var')
        } = ${init}; `);
    }

    const edges = reconstructEdges(f);

    const resultNodes = f.nodes.filter(n => this.hasResult(n.op));
    for (const n of resultNodes) {
      lines.push(`  let ${nodeResId(n.id)}; `);
    }

    const emittedPure = new Set<string>();
    const emitPure = (nodeId: string) => {
      if (emittedPure.has(nodeId)) return;
      const node = f.nodes.find(n => n.id === nodeId);
      if (!node || this.isExecutable(node.op, edges, node.id)) return;

      // Mark as emitted to prevent recursion during dependency emission
      emittedPure.add(nodeId);

      // Emit data dependencies first
      edges.filter(e => e.to === nodeId && e.type === 'data').forEach(edge => {
        emitPure(edge.from);
      });

      lines.push(`  ${nodeResId(node.id)} = ${this.compileExpression(node, f, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, true, emitPure, edges)}; `);
    };

    // Compile node logic
    lines.push(`  // Pure Nodes (lazy emission)`);

    // Execution Chain
    const entryNodes = f.nodes.filter(n => {
      const hasExecIn = edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op, edges, n.id);
    });

    for (const entry of entryNodes) {
      this.emitChain('  ', entry, f, lines, new Set(), sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
    }

    lines.push(`  return 0; // Default return`);
    lines.push(`}`);
  }

  private isExecutable(op: string, edges: Edge[], nodeId: string) {
    const isSideEffecting = op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'texture_store' || op === 'call_func' || op === 'func_return' || op === 'array_set' ||
      op === 'cmd_resize_resource' || op === 'cmd_draw' || op === 'cmd_dispatch';

    if (isSideEffecting) return true;

    // A node is also considered "executable" if it has an outgoing execution edge,
    // meaning the user explicitly wants it to be part of the control flow.
    return edges.some(e => e.from === nodeId && e.type === 'execution');
  }

  private emitChain(indent: string, startNode: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], inferredTypes: InferredTypes, emitPure: (id: string) => void, edges: Edge[]) {
    let curr: Node | undefined = startNode;

    while (curr) {
      if (visited.has(curr.id)) {
        if (curr.op !== 'flow_loop') break;
      }
      visited.add(curr.id);

      // Ensure all data dependencies for this executable node are emitted
      edges.filter(e => e.to === curr!.id && e.type === 'data').forEach(e => emitPure(e.from));
      for (const k in curr) {
        if (['id', 'op', 'metadata', 'func', 'args', 'dispatch'].includes(k)) continue;
        const val = (curr as any)[k];
        if (typeof val === 'string' && func.nodes.some(n => n.id === val)) emitPure(val);
      }

      // If the node itself has a result (like call_func), ensure it's "emitted"
      // even if it's executable, so its variable is settled if used later.
      if (this.hasResult(curr.op)) {
        // For executable nodes that have results, we emit them directly in the chain
        this.emitNode(indent, curr, func, lines, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      } else if (curr.op === 'flow_branch') {
        this.emitBranch(indent, curr, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return;
      } else if (curr.op === 'flow_loop') {
        this.emitLoop(indent, curr, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return;
      } else if (curr.op === 'func_return') {
        lines.push(`${indent}return ${this.resolveArg(curr, 'val', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)};`);
        return;
      } else {
        this.emitNode(indent, curr, func, lines, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      }

      const outEdge = edges.find(e => e.from === curr!.id && e.portOut === 'exec_out' && e.type === 'execution');
      curr = outEdge ? func.nodes.find(n => n.id === outEdge.to) : undefined;
    }
  }

  private emitBranch(indent: string, node: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], inferredTypes: InferredTypes, emitPure: (id: string) => void, edges: Edge[]) {
    const cond = this.resolveArg(node, 'cond', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
    lines.push(`${indent}if (${cond}) {`);
    const trueEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_true' && e.type === 'execution');
    const trueNode = trueEdge ? func.nodes.find(n => n.id === trueEdge.to) : undefined;
    if (trueNode) this.emitChain(indent + '  ', trueNode, func, lines, new Set(visited), sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
    lines.push(`${indent}} else {`);
    const falseEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_false' && e.type === 'execution');
    const falseNode = falseEdge ? func.nodes.find(n => n.id === falseEdge.to) : undefined;
    if (falseNode) this.emitChain(indent + '  ', falseNode, func, lines, new Set(visited), sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
    lines.push(`${indent}}`);
  }

  private emitLoop(indent: string, node: Node, func: FunctionDef, lines: string[], visited: Set<string>, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], inferredTypes: InferredTypes, emitPure: (id: string) => void, edges: Edge[]) {
    const start = this.resolveArg(node, 'start', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
    const end = this.resolveArg(node, 'end', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
    const loopVar = `loop_${node.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    lines.push(`${indent}for (let ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);

    const bodyEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_body' && e.type === 'execution');
    const bodyNode = bodyEdge ? func.nodes.find(n => n.id === bodyEdge.to) : undefined;
    if (bodyNode) this.emitChain(indent + '  ', bodyNode, func, lines, new Set(visited), sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
    lines.push(`${indent}}`);

    const compEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_completed' && e.type === 'execution');
    const nextNode = compEdge ? func.nodes.find(n => n.id === compEdge.to) : undefined;
    if (nextNode) this.emitChain(indent, nextNode, func, lines, visited, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
  }

  private emitNode(indent: string, node: Node, func: FunctionDef, lines: string[], sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], inferredTypes: InferredTypes, emitPure: (id: string) => void, edges: Edge[]) {
    if (node.op === 'cmd_dispatch') {
      const targetId = node['func'];
      const dimExpr = this.resolveArg(node, 'dispatch', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      lines.push(`${indent}await ctx.globals.dispatch('${targetId}', ${dimExpr}, ${this.generateArgsObject(node, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)});`);
    }
    else if (node.op === 'call_func') {
      const targetId = node['func'];
      const targetFunc = allFunctions.find(f => f.id === targetId);
      if (targetFunc?.type === 'shader') {
        const dimExpr = this.resolveArg(node, 'dispatch', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        lines.push(`${indent}await ctx.globals.dispatch('${targetId}', ${dimExpr}, ${this.generateArgsObject(node, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)});`);
      } else if (targetFunc) {
        lines.push(`${indent}${nodeResId(node.id)} = await ${funcName(targetId)}(ctx, ${this.generateArgsObject(node, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)});`);
      }
    }
    else if (node.op === 'cmd_draw') {
      const target = node['target'];
      const vertex = node['vertex'];
      const fragment = node['fragment'];
      const count = this.resolveArg(node, 'count', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      const pipeline = JSON.stringify(node['pipeline'] || {});
      lines.push(`${indent}await ctx.globals.draw('${target}', '${vertex}', '${fragment}', ${count}, ${pipeline});`);
    }
    else if (node.op === 'cmd_resize_resource') {
      const resId = node['resource'];
      const size = this.resolveArg(node, 'size', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      const resolveRaw = (key: string) => {
        const edge = edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
        if (edge || node[key] !== undefined) return this.resolveArg(node, key, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return 'undefined';
      };
      lines.push(`${indent}ctx.globals.resize('${resId}', ${size}, ${resolveRaw('format')}, ${resolveRaw('clear')});`);
    }
    else if (node.op === 'var_set') {
      const val = this.resolveArg(node, 'val', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      const varId = node['var'];
      if (func.localVars.some(v => v.id === varId)) lines.push(`${indent}${sanitizeId(varId, 'var')} = ${val};`);
      else if (func.inputs.some(i => i.id === varId)) lines.push(`${indent}${sanitizeId(varId, 'input')} = ${val};`);
      else throw new Error(`JIT Error: Cannot set undefined variable '${varId}'`);
    }
    else if (node.op === 'cmd_sync_to_cpu') {
      const resId = node['resource'];
      lines.push(`${indent}ctx.globals.executeSyncToCpu('${resId}');`);
    }
    else if (node.op === 'cmd_wait_cpu_sync') {
      const resId = node['resource'];
      lines.push(`${indent}await ctx.globals.executeWaitCpuSync('${resId}');`);
    }
    else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'];
      const idx = this.resolveArg(node, 'index', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      const val = this.resolveArg(node, 'value', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      lines.push(`${indent}ctx.resources.get('${bufferId}').data[${idx}] = ${val};`);
    }
    else if (node.op === 'texture_store') {
      const texId = node['tex'];
      const coords = this.resolveArg(node, 'coords', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      const val = this.resolveArg(node, 'value', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      lines.push(`${indent}((coords, val) => {
        const res = ctx.resources.get('${texId}');
        if (!res) return;
        const x = Math.floor(coords[0]), y = Math.floor(coords[1]);
        if (x >= 0 && x < res.width && y >= 0 && y < res.height) res.data[y * res.width + x] = val;
      })(${coords}, ${val});`);
    }
    else if (this.hasResult(node.op)) {
      lines.push(`${indent}${nodeResId(node.id)} = ${this.compileExpression(node, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, true, emitPure, edges)};`);
    }
  }

  private resolveArg(node: Node, key: string, func: FunctionDef, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], inferredTypes: InferredTypes, emitPure: (id: string) => void, edges: Edge[]): string {
    const edge = edges.find(e => e.to === node.id && (e.portIn === key || (key === 'val' && e.portIn === 'value')) && e.type === 'data');
    if (edge) {
      const source = func.nodes.find(n => n.id === edge.from);
      if (source) return this.compileExpression(source, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, false, emitPure, edges);
    }

    let val: any = undefined;
    if (key.includes('.') || key.includes('[')) {
      const parts = key.split(/[\.\[\]]/).filter(p => p !== '');
      let curr: any = node;
      for (const p of parts) {
        if (curr === undefined || curr === null) break;
        curr = curr[p];
      }
      val = curr;
    } else {
      val = node[key];
    }

    if (val !== undefined) {
      const resolveString = (s: any) => {
        if (typeof s === 'string' && !['var', 'func', 'resource', 'buffer'].includes(key)) {
          if (func.localVars.some(v => v.id === s)) return sanitizeId(s, 'var');
          if (func.inputs.some(i => i.id === s)) return sanitizeId(s, 'input');
          if (this.ir?.inputs.some((i: any) => i.id === s)) return `ctx.inputs.get('${s}')`;
          const targetNode = func.nodes.find(n => n.id === s);
          if (targetNode && targetNode.id !== node.id) return this.compileExpression(targetNode, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, false, emitPure, edges);
        }
        return JSON.stringify(s);
      };

      if (Array.isArray(val)) {
        return `[${val.map(v => resolveString(v)).join(', ')}]`;
      }
      return resolveString(val);
    }
    return '0';
  }

  private compileExpression(node: Node, func: FunctionDef, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], inferredTypes: InferredTypes, forceEmit: boolean = false, emitPure: (id: string) => void, edges: Edge[]): string {
    if (!forceEmit && this.hasResult(node.op)) {
      emitPure(node.id);
      return nodeResId(node.id);
    }

    const a = (k = 'a') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
    const b = (k = 'b') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
    const val = (k = 'val') => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);

    switch (node.op) {
      case 'var_get': {
        const varId = node['var'];
        if (func.localVars.some(v => v.id === varId)) return sanitizeId(varId, 'var');
        if (func.inputs.some(i => i.id === varId)) return sanitizeId(varId, 'input');
        return `((id) => { const v = ctx.inputs.get(id); if (v !== undefined) return v; throw new Error("Variable '" + id + "' is not defined"); })('${varId}')`;
      }
      case 'literal': return JSON.stringify(node['val']);
      case 'loop_index': return `loop_${node['loop'].replace(/[^a-zA-Z0-9_]/g, '_')}`;
      case 'buffer_load': {
        const bufferId = node['buffer'];
        const idx = a('index');
        return `((idx) => {
          const res = ctx.resources.get('${bufferId}');
          if (!res) return 0;
          if (idx < 0 || idx >= res.data.length) throw new Error("Runtime Error: buffer_load OOB");
          return res.data[idx];
        })(${idx})`;
      }
      case 'texture_load': {
        const texId = node['tex'];
        const coords = this.resolveArg(node, 'coords', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
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
        const uv = this.resolveArg(node, 'coords', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `((uv) => {
          const res = ctx.resources.get('${texId}');
          if (!res) return [0, 0, 0, 0];
          const wrap = res.def.sampler?.wrap || 'clamp';
          const filter = res.def.sampler?.filter || 'nearest';

          const applyWrap = (c) => {
            if (wrap === 'repeat') return c - Math.floor(c);
            if (wrap === 'mirror') {
              const m = (c % 2 + 2) % 2;
              return m > 1 ? 2 - m : m;
            }
            return Math.max(0, Math.min(1, c));
          };

          const u = applyWrap(uv[0]);
          const v = applyWrap(uv[1]);
          const w = res.width;
          const h = res.height;

          const getSample = (x, y) => {
             const sx = Math.max(0, Math.min(w - 1, x));
             const sy = Math.max(0, Math.min(h - 1, y));
             const val = res.data[sy * w + sx];
             return val !== undefined ? val : [0, 0, 0, 0];
          };

          if (filter === 'nearest') {
            const x = Math.min(Math.floor(u * w), w - 1);
            const y = Math.min(Math.floor(v * h), h - 1);
            const val = res.data[y * w + x];
            return val !== undefined ? val : [0, 0, 0, 0];
          }

          const tx = u * w - 0.5;
          const ty = v * h - 0.5;
          const x0 = Math.floor(tx);
          const y0 = Math.floor(ty);
          const fx = tx - x0;
          const fy = ty - y0;

          const getWrappedSample = (targetX, targetY) => {
             let sx = targetX;
             let sy = targetY;
             if (wrap === 'clamp') {
                sx = Math.max(0, Math.min(w - 1, sx));
                sy = Math.max(0, Math.min(h - 1, sy));
             } else if (wrap === 'repeat') {
                sx = ((sx % w) + w) % w;
                sy = ((sy % h) + h) % h;
             } else if (wrap === 'mirror') {
                const mx = ((sx % (2 * w)) + (2 * w)) % (2 * w);
                sx = mx >= w ? 2 * w - 1 - mx : mx;
                const my = ((sy % (2 * h)) + (2 * h)) % (2 * h);
                sy = my >= h ? 2 * h - 1 - my : my;
             }
             const val = res.data[sy * w + sx];
             return val !== undefined ? val : [0, 0, 0, 0];
          };

          const s00 = getWrappedSample(x0, y0);
          const s10 = getWrappedSample(x0 + 1, y0);
          const s01 = getWrappedSample(x0, y0 + 1);
          const s11 = getWrappedSample(x0 + 1, y0 + 1);

          const lerp = (a, b, t) => {
             if (Array.isArray(a)) return a.map((v, i) => v * (1 - t) + b[i] * t);
             return a * (1 - t) + b * t;
          };

          const top = lerp(s00, s10, fx);
          const bot = lerp(s01, s11, fx);
          return lerp(top, bot, fy);
        })(${uv})`;
      }
      case 'resource_get_size': {
        const resId = node['resource'];
        return `((id) => {
          const res = ctx.resources.get(id);
          if (!res) return [0, 0];
          return res.def.type === 'texture2d' ? [res.width, res.height] : [res.width, 0];
        })('${resId}')`;
      }
      case 'resource_get_format': {
        const resId = node['resource'];
        return `((id) => {
          const res = ctx.resources.get(id);
          return res ? (res.def.format || 'rgba8') : 'rgba8';
        })('${resId}')`;
      }

      case 'math_neg': return `_applyUnary(${val()}, v => -v)`;
      case 'math_abs': return `_applyUnary(${val()}, Math.abs)`;
      case 'math_sign': return `_applyUnary(${val()}, Math.sign)`;
      case 'math_sin': return `_applyUnary(${val()}, Math.sin)`;
      case 'math_cos': return `_applyUnary(${val()}, Math.cos)`;
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

      case 'math_add': {
        const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${aExpr}, ${bExpr}, (x, y) => x + y)`;
      }
      case 'math_sub': {
        const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${aExpr}, ${bExpr}, (x, y) => x - y)`;
      }
      case 'math_mul': {
        const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${aExpr}, ${bExpr}, (x, y) => x * y)`;
      }
      case 'math_div': {
        const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${aExpr}, ${bExpr}, (x, y) => x / y)`;
      }
      case 'math_mod': {
        const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${aExpr}, ${bExpr}, (x, y) => x % y)`;
      }
      case 'math_pow': {
        const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${aExpr}, ${bExpr}, Math.pow)`;
      }
      case 'math_min': {
        const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${aExpr}, ${bExpr}, Math.min)`;
      }
      case 'math_max': {
        const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${aExpr}, ${bExpr}, Math.max)`;
      }
      case 'math_atan2': {
        const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${aExpr}, ${bExpr}, Math.atan2)`;
      }
      case 'math_clamp': {
        const result = this.resolveCoercedArgs(node, ['val', 'min', 'max'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `((v, min, max) => _applyBinary(_applyBinary(v, min, Math.max), max, Math.min))(${result[0]}, ${result[1]}, ${result[2]})`;
      }
      case 'math_mad': {
        const [aExp, bExp, cExp] = this.resolveCoercedArgs(node, ['a', 'b', 'c'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(_applyBinary(${aExp}, ${bExp}, (x, y) => x * y), ${cExp}, (x, y) => x + y)`;
      }
      case 'math_mix': {
        const [aExp, bExp, tExp] = this.resolveCoercedArgs(node, ['a', 'b', 't'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `((a, b, t) => _applyBinary(_applyBinary(a, _applyBinary(1, t, (x, y) => x - y), (x, y) => x * y), _applyBinary(b, t, (x, y) => x * y), (x, y) => x + y))(${aExp}, ${bExp}, ${tExp})`;
      }
      case 'math_step': {
        const [edge, x] = this.resolveCoercedArgs(node, ['edge', 'val'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `_applyBinary(${edge}, ${x}, (e, x) => x < e ? 0 : 1)`;
      }
      case 'math_smoothstep': {
        const [e0, e1, v] = this.resolveCoercedArgs(node, ['edge0', 'edge1', 'val'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `((v, edge0, edge1) => _applyUnary(_applyBinary(_applyBinary(v, edge0, (x, e) => (x - e)), _applyBinary(edge1, edge0, (e1, e0) => (e1 - e0)), (n, d) => Math.max(0, Math.min(1, n / d))), t => t * t * (3 - 2 * t)))(${v}, ${e0}, ${e1})`;
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

      case 'color_mix': {
        const dst = a();
        const src = b();
        const tEdge = edges.find(e => e.to === node.id && e.portIn === 't' && e.type === 'data');
        if (tEdge || (node['t'] !== undefined)) {
          const t = this.resolveArg(node, 't', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
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

      case 'vec_get_element': return `(${this.resolveArg(node, 'vec', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)}[${this.resolveArg(node, 'index', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)}])`;
      case 'vec_mix': {
        const [aExp, bExp, tExp] = this.resolveCoercedArgs(node, ['a', 'b', 't'], 'unify', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        return `((a, b, t) => _applyBinary(_applyBinary(a, _applyBinary(1, t, (x, y) => x - y), (x, y) => x * y), _applyBinary(b, t, (x, y) => x * y), (x, y) => x + y))(${aExp}, ${bExp}, ${tExp})`;
      }

      case 'math_pi': return `Math.PI`;
      case 'math_e': return `Math.E`;

      case 'math_gt': return `_applyBinary(${a()}, ${b()}, (x, y) => x > y ? 1.0 : 0.0)`;
      case 'math_lt': return `_applyBinary(${a()}, ${b()}, (x, y) => x < y ? 1.0 : 0.0)`;
      case 'math_ge': return `_applyBinary(${a()}, ${b()}, (x, y) => x >= y ? 1.0 : 0.0)`;
      case 'math_le': return `_applyBinary(${a()}, ${b()}, (x, y) => x <= y ? 1.0 : 0.0)`;
      case 'math_eq': return `_applyBinary(${a()}, ${b()}, (x, y) => x === y ? 1.0 : 0.0)`;
      case 'math_neq': return `_applyBinary(${a()}, ${b()}, (x, y) => x !== y ? 1.0 : 0.0)`;

      case 'math_and': return `_applyBinary(${a()}, ${b()}, (x, y) => (x && y) ? 1.0 : 0.0)`;
      case 'math_or': return `_applyBinary(${a()}, ${b()}, (x, y) => (x || y) ? 1.0 : 0.0)`;
      case 'math_xor': return `_applyBinary(${a()}, ${b()}, (x, y) => (x ^ y) ? 1.0 : 0.0)`;
      case 'math_not': return `_applyUnary(${val()}, v => (!v) ? 1.0 : 0.0)`;

      case 'float': return `Number(${val()})`;
      case 'int': return `Math.trunc(${val()})`;
      case 'bool': return `Boolean(${val()})`;
      case 'static_cast_float': return `Number(${val()})`;
      case 'static_cast_int': return `(${val()} | 0)`;
      case 'mat_inverse': return a('val');
      case 'static_cast_uint': return `Math.abs(Math.trunc(${val()}))`;
      case 'static_cast_bool': return `Boolean(${val()})`;

      case 'float2': return `[${a('x')}, ${a('y')}]`;
      case 'float3': return `[${a('x')}, ${a('y')}, ${a('z')}]`;
      case 'float4': return `[${a('x')}, ${a('y')}, ${a('z')}, ${a('w')}]`;
      case 'float3x3':
      case 'float4x4': {
        const size = node.op === 'float3x3' ? 9 : 16;
        if (node['vals'] !== undefined || edges.some(e => e.to === node.id && e.portIn === 'vals')) {
          return a('vals');
        }
        const keys = size === 9 ? ['m00', 'm10', 'm20', 'm01', 'm11', 'm21', 'm02', 'm12', 'm22'] :
          ['m00', 'm10', 'm20', 'm30', 'm01', 'm11', 'm21', 'm31', 'm02', 'm12', 'm22', 'm32', 'm03', 'm13', 'm23', 'm33'];
        return `[${keys.map(k => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)).join(', ')}]`;
      }
      case 'vec_dot': return `_vec_dot(${a()}, ${b()})`;
      case 'vec_length': return `_vec_length(${a()})`;
      case 'vec_normalize': return `_vec_normalize(${a()})`;
      case 'vec_swizzle': {
        const vec = this.resolveArg(node, 'vec', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        const channels = node['channels'] || 'x';
        const map: any = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
        const idxs = channels.split('').map((c: string) => map[c]);
        if (idxs.length === 1) return `${vec}[${idxs[0]}]`;
        return `[${idxs.map((i: number) => `${vec}[${i}]`).join(', ')}]`;
      }

      case 'struct_construct': {
        const type = node['type'];
        const structDef = this.ir?.structs?.find(s => s.id === type);
        const parts = structDef ? structDef.members.map(m => `'${m.name}': ${this.resolveArg(node, `values.${m.name}`, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)}`) : [];
        return `{ ${parts.join(', ')} }`;
      }
      case 'struct_extract': return `(${this.resolveArg(node, 'struct', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)}['${node['field'] || node['member']}'])`;

      case 'array_construct': {
        const values = node['values'];
        if (Array.isArray(values)) {
          const items = values.map((_, i) => this.resolveArg(node, `values[${i}]`, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges));
          return `[${items.join(', ')}]`;
        }
        const len = this.resolveArg(node, 'length', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        const fill = this.resolveArg(node, 'fill', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
        if (len !== undefined && len !== 'undefined') {
          return `new Array(${len}).fill(${fill ?? 0})`;
        }
        return `[]`;
      }
      case 'array_extract': return `${this.resolveArg(node, 'array', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)}[${a('index')}]`;
      case 'array_length': return `(${this.resolveArg(node, 'array', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)}.length)`;
      case 'array_set': return `(${this.resolveArg(node, 'array', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)}[${a('index')}] = ${val('value')})`;

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
      case 'quat_slerp': return `_quat_slerp(${a()}, ${b()}, ${this.resolveArg(node, 't', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)})`;
      case 'quat_to_float4x4': return `_quat_to_mat4(${this.resolveArg(node, 'q', func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges)})`;

      default: return '0';
    }
  }

  private resolveCoercedArgs(
    node: Node,
    keys: string[],
    mode: 'float' | 'unify',
    func: FunctionDef,
    sanitizeId: (id: string, type?: any) => string,
    nodeResId: (id: string) => string,
    funcName: (id: string) => string,
    allFunctions: FunctionDef[],
    inferredTypes: InferredTypes,
    emitPure: (id: string) => void,
    edges: Edge[]
  ): string[] {
    const rawArgs = keys.map(k => this.resolveArg(node, k, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges));

    if (!inferredTypes) return rawArgs; // Should not happen with new architecture

    const getType = (k: string) => {
      const val = node[k];
      // Check cached/inferred type of the node if it's a reference
      if (typeof val === 'string') {
        const t = inferredTypes.get(val);
        if (t) return t;
        // Check locals/inputs
        if (func.localVars.some(v => v.id === val)) return func.localVars.find(v => v.id === val)!.type;
        if (func.inputs.some(i => i.id === val)) return func.inputs.find(i => i.id === val)!.type;
      }
      if (typeof val === 'number') return Number.isInteger(val) ? 'int' : 'float';
      if (typeof val === 'boolean') return 'bool';
      return 'float';
    };

    const argTypes = keys.map(getType);

    if (mode === 'float') {
      return rawArgs.map((arg, i) => {
        const t = argTypes[i];
        if (t === 'int' || t === 'i32' || t === 'uint' || t === 'u32' || t === 'bool' || t === 'boolean') {
          return `Number(${arg})`;
        }
        return arg;
      });
    } else if (mode === 'unify') {
      const hasFloat = argTypes.some(t => t.includes('float') || t.includes('vec') || t.includes('mat') || t === 'f32');
      if (hasFloat) {
        return rawArgs.map((arg, i) => {
          const t = argTypes[i];
          if (t === 'int' || t === 'i32' || t === 'uint' || t === 'u32' || t === 'bool') {
            return `Number(${arg})`;
          }
          return arg;
        });
      }
    }
    return rawArgs;
  }

  private generateArgsObject(node: Node, func: FunctionDef, sanitizeId: (id: string, type?: any) => string, nodeResId: (id: string) => string, funcName: (id: string) => string, allFunctions: FunctionDef[], inferredTypes: InferredTypes, emitPure: (id: string) => void, edges: Edge[]): string {
    const targetId = node['func'] as string;
    const targetFunc = allFunctions.find(f => f.id === targetId);
    if (!targetFunc) return '{}';


    const parts: string[] = [];
    targetFunc.inputs.forEach(input => {
      const valExpr = this.resolveArg(node, `args.${input.id}`, func, sanitizeId, nodeResId, funcName, allFunctions, inferredTypes, emitPure, edges);
      parts.push(`'${input.id}': ${valExpr}`);
    });
    return `{ ${parts.join(', ')} }`;
  }
}
