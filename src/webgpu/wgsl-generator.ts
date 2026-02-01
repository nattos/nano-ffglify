
import { FunctionDef, Node, Edge, DataType, ResourceDef, IRDocument, StructDef } from '../ir/types';

/**
 * WGSL Generator
 * Transpiles IR Functions into WGSL shader code.
 */

export interface WgslOptions {
  globalBufferBinding?: number; // If set, generate globals buffer and use it for var_get/set
  varMap?: Map<string, number>; // Map var name to index in globals buffer
  resourceBindings?: Map<string, number>; // Map resource ID (buffer/texture) to binding index (group 0)
  samplerBindings?: Map<string, number>; // Map resource ID to sampler binding index
  resourceDefs?: Map<string, ResourceDef>; // Definitions for typed buffer generation
  varTypes?: Map<string, DataType>; // Map variable ID to DataType for global buffer sizing
  nodeTypes?: Map<string, DataType>; // Map node ID to inferred DataType
  inputBinding?: number; // Binding for shader inputs (uniform)
  stage?: 'compute' | 'vertex' | 'fragment';
  excludeIds?: string[];
  entryPointId?: string; // Cache entry point ID for resolution
  structs?: StructDef[]; // Optional structs for dependency resolution
}

export class WgslGenerator {
  private helpers = new Set<string>();
  private allUsedBuiltins = new Set<string>();

  /**
   * Compiles IR Functions into WGSL shader code.
   * @param functions All functions in the IR (for resolution of call_func)
   * @param entryPointId The ID of the function to use as the entry point
   * @param options Compilation options
   * @param ir Optional partial IR document for additional metadata (structs, resources)
   */
  compileFunctions(functions: FunctionDef[], entryPointId: string, options: WgslOptions = {}, ir?: Partial<IRDocument>): string {
    options.entryPointId = entryPointId; // Ensure options has the entry point ID
    const entryFunc = functions.find(f => f.id === entryPointId);
    if (!entryFunc) throw new Error(`Entry point function '${entryPointId}' not found`);
    options.entryPointId = entryPointId;

    this.helpers.clear();
    this.allUsedBuiltins.clear();

    const fullIr: IRDocument = {
      version: '1.0',
      meta: { name: 'generated' },
      entryPoint: entryPointId,
      inputs: [],
      resources: Array.from(options.resourceDefs?.values() || []),
      functions,
      structs: ir?.structs || [],
      ...ir
    };

    // 1. Map built-ins across all potential functions
    functions.forEach(f => {
      f.nodes.forEach(n => {
        if (n.op === 'builtin_get') this.allUsedBuiltins.add(n['name']);
      });
    });

    const lines: string[] = []; // Top-level things: structs, samplers
    const functionLines: string[] = []; // Actual function code

    // 2. Structs
    this.generateStructs(fullIr, lines);

    // 4. Entry point and dependencies
    const emitted = new Set<string>();
    const toEmit = [entryPointId];

    while (toEmit.length > 0) {
      const fid = toEmit.pop()!;
      if (emitted.has(fid)) continue;
      emitted.add(fid);

      const f = functions.find(func => func.id === fid);
      if (f) {
        this.emitFunction(f, fid === entryPointId, functionLines, options, fullIr);
        functionLines.push(''); // Decorate with newline
        // Find called functions
        f.nodes.forEach(n => {
          if (n.op === 'call_func' && typeof n.func === 'string') {
            toEmit.push(n.func);
          }
        });
      }
    }

    // Identify used resources for sampler helpers
    const usedResources = new Set<string>();
    emitted.forEach(fid => {
      const f = functions.find(func => func.id === fid);
      if (f) {
        const used = WgslGenerator.findUsedResources(f, fullIr);
        used.forEach(r => usedResources.add(r));
      }
    });

    // 3. Resources (Textures/Buffers) - Sampler Helpers
    this.emitTextureSamplers(lines, options, fullIr, usedResources);

    // Assemble final shader code
    const finalLines: string[] = [];
    finalLines.push('diagnostic(off, derivative_uniformity);');
    finalLines.push('');

    // Globals Buffer
    if (options.globalBufferBinding !== undefined) {
      finalLines.push('struct GlobalsBuffer { data: array<f32> }');
      finalLines.push(`@group(0) @binding(${options.globalBufferBinding}) var<storage, read_write> b_globals : GlobalsBuffer;`);
      finalLines.push('');
    }

    // 2.5. Inputs Buffer (Uniforms / Non-Stage IO)
    // For shaders, we use the function's own inputs. For direct execution of a graph, we might use global inputs.
    const inputSource = (entryFunc.type === 'shader') ? entryFunc.inputs : fullIr.inputs;
    const nonBuiltinInputs = inputSource.filter(i => !(i as any).builtin);

    if (options.stage === 'compute' && options.inputBinding !== undefined && nonBuiltinInputs.length > 0) {
      const docInputs = [...nonBuiltinInputs];
      docInputs.sort((a, b) => {
        const aIsArr = a.type.includes('[]') || (a.type.startsWith('array<') && !a.type.includes(','));
        const bIsArr = b.type.includes('[]') || (b.type.startsWith('array<') && !b.type.includes(','));
        if (aIsArr && !bIsArr) return 1;
        if (!aIsArr && bIsArr) return -1;
        return 0;
      });

      finalLines.push('struct Inputs {');
      for (const input of docInputs) {
        let type = this.resolveType(input.type);
        if (type === 'bool') type = 'u32';
        finalLines.push(`  ${input.id} : ${type},`);
      }
      finalLines.push('}');
      finalLines.push(`@group(0) @binding(${options.inputBinding}) var<storage, read> b_inputs : Inputs;`);
      finalLines.push('');
    }

    // Resource Bindings
    if (options.resourceBindings) {
      const usedResources = new Set<string>();
      emitted.forEach(fid => {
        const f = functions.find(func => func.id === fid);
        if (f) {
          const used = WgslGenerator.findUsedResources(f, fullIr);
          used.forEach(r => usedResources.add(r));
        }
      });

      options.resourceBindings.forEach((bindingIdx, resId) => {
        if (!usedResources.has(resId)) return;

        const def = options.resourceDefs?.get(resId);
        if (def?.type === 'buffer' || !def) {
          const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
          const structName = `Buffer_${resId}`;
          finalLines.push(`struct ${structName} { data: array<${type}> }`);
          const bufVar = this.getBufferVar(resId);
          finalLines.push(`@group(0) @binding(${bindingIdx}) var<storage, read_write> ${bufVar} : ${structName};`);
        } else if (def.type === 'texture2d') {
          const isStorage = functions.some(f => f.nodes.some(n => n.op === 'texture_store' && n['tex'] === resId));
          if (isStorage) {
            let format = 'rgba8unorm';
            const irFormat = def.format;
            if (typeof irFormat === 'string') {
              const formatMap: Record<string, string> = { 'rgba8': 'rgba8unorm', 'rgba16f': 'rgba16float', 'rgba32f': 'rgba32float', 'r32f': 'r32float' };
              format = formatMap[irFormat] || irFormat;
            }
            finalLines.push(`@group(0) @binding(${bindingIdx}) var ${resId} : texture_storage_2d<${format}, write>;`);
          } else {
            finalLines.push(`@group(0) @binding(${bindingIdx}) var ${resId} : texture_2d<f32>;`);
          }
        }
      });
      if (options.resourceBindings.size > 0) finalLines.push('');
    }

    // Add injected helpers
    if (this.helpers.size > 0) {
      finalLines.push('// Injected Helpers');
      this.helpers.forEach(h => finalLines.push(h));
      finalLines.push('');
    }

    // Global built-ins
    const builtins = ['global_invocation_id', 'local_invocation_id', 'workgroup_id', 'local_invocation_index', 'num_workgroups', 'position', 'frag_coord', 'front_facing', 'sample_index', 'vertex_index', 'instance_index'];
    const builtinTypes: Record<string, string> = {
      'global_invocation_id': 'vec3<u32>', 'local_invocation_id': 'vec3<u32>', 'workgroup_id': 'vec3<u32>',
      'local_invocation_index': 'u32', 'num_workgroups': 'vec3<u32>', 'position': 'vec4<f32>',
      'frag_coord': 'vec4<f32>', 'front_facing': 'bool', 'sample_index': 'u32', 'vertex_index': 'u32', 'instance_index': 'u32'
    };
    const builtinVarNames: Record<string, string> = {
      'global_invocation_id': 'GlobalInvocationID', 'local_invocation_id': 'LocalInvocationID',
      'workgroup_id': 'WorkgroupID', 'local_invocation_index': 'LocalInvocationIndex',
      'num_workgroups': 'NumWorkgroups', 'position': 'Position', 'frag_coord': 'FragCoord',
      'front_facing': 'FrontFacing', 'sample_index': 'SampleIndex', 'vertex_index': 'VertexIndex', 'instance_index': 'InstanceIndex'
    };

    builtins.forEach(b => {
      if (this.allUsedBuiltins.has(b)) {
        finalLines.push(`var<private> ${builtinVarNames[b]} : ${builtinTypes[b]};`);
      }
    });

    finalLines.push(...lines);
    finalLines.push(...functionLines);

    return finalLines.join('\n');
  }

  compile(ir: IRDocument, entryPointId: string, options: WgslOptions = {}): string {
    if (!options.resourceDefs) options.resourceDefs = new Map(ir.resources.map(r => [r.id, r]));
    return this.compileFunctions(ir.functions, entryPointId, options, ir);
  }

  private addHelper(code: string) {
    this.helpers.add(code);
  }

  private emitTextureSamplers(lines: string[], options: WgslOptions, ir: IRDocument, usedResources: Set<string>) {
    if (!options.resourceDefs) return;
    options.resourceDefs.forEach((def, id) => {
      if (!usedResources.has(id)) return;
      if (def.type === 'texture2d') {
        const isStorage = ir.functions.some(f => f.nodes.some(n => n.op === 'texture_store' && n['tex'] === id));
        if (isStorage) return; // Skip sampling helper for storage textures

        const wrap = def.sampler?.wrap || 'clamp';
        const filter = def.sampler?.filter || 'nearest';

        lines.push(`fn sample_${id}(uv: vec2<f32>) -> vec4<f32> {`);
        lines.push(`  let size = vec2<f32>(textureDimensions(${id}));`);

        // Wrap Logic
        if (wrap === 'repeat') {
          lines.push(`  let uv_wrap = uv - floor(uv);`);
        } else if (wrap === 'mirror') {
          // Mirror Repeat: 1.0 - abs(mod(uv, 2.0) - 1.0)
          lines.push(`  let uv_mod2 = uv - 2.0 * floor(uv * 0.5);`);
          lines.push(`  let uv_wrap = 1.0 - abs(uv_mod2 - 1.0);`);
        } else {
          lines.push(`  let uv_wrap = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));`);
        }

        if (filter === 'linear') {
          // Bilinear Filtering
          lines.push(`  let texel_pos = uv_wrap * size - 0.5;`);
          lines.push(`  let f = fract(texel_pos);`);
          lines.push(`  let base_coord = vec2<i32>(floor(texel_pos));`);

          lines.push(`  let c00 = vec2<i32>(base_coord);`);
          lines.push(`  let c10 = vec2<i32>(base_coord) + vec2<i32>(1, 0);`);
          lines.push(`  let c01 = vec2<i32>(base_coord) + vec2<i32>(0, 1);`);
          lines.push(`  let c11 = vec2<i32>(base_coord) + vec2<i32>(1, 1);`);

          lines.push(`  let s00 = textureLoad(${id}, clamp(c00, vec2<i32>(0), vec2<i32>(size) - 1), 0);`);
          lines.push(`  let s10 = textureLoad(${id}, clamp(c10, vec2<i32>(0), vec2<i32>(size) - 1), 0);`);
          lines.push(`  let s01 = textureLoad(${id}, clamp(c01, vec2<i32>(0), vec2<i32>(size) - 1), 0);`);
          lines.push(`  let s11 = textureLoad(${id}, clamp(c11, vec2<i32>(0), vec2<i32>(size) - 1), 0);`);

          lines.push(`  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);`);
        } else {
          // Nearest Neighbor
          lines.push(`  let coord = vec2<i32>(floor(uv_wrap * size));`);
          lines.push(`  let safe_coord = clamp(coord, vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));`);
          lines.push(`  return textureLoad(${id}, safe_coord, 0);`);
        }
        lines.push(`}`);
        lines.push('');
      }
    });
  }

  private generateStructs(ir: IRDocument, lines: string[]) {
    for (const s of ir.structs) {
      lines.push(`struct ${s.id} {`);
      let locationIdx = 0;
      for (const m of s.members) {
        const type = this.resolveType(m.type);
        let decorators = '';
        if (m.builtin) {
          decorators += `@builtin(${m.builtin}) `;
        } else {
          // Fragment/Vertex IO requires @location for all non-builtin members
          decorators += `@location(${m.location !== undefined ? m.location : locationIdx++}) `;
        }
        lines.push(`  ${decorators}${m.name} : ${type},`);
      }
      lines.push(`}`);
      lines.push('');
    }
  }

  private emitFunction(func: FunctionDef, isEntryPoint: boolean, lines: string[], options: WgslOptions, ir: IRDocument) {
    if (isEntryPoint) {
      if (options.stage === 'vertex') {
        const retType = this.resolveType(func.outputs[0]?.type || 'vec4<f32>');
        lines.push(`@vertex`);
        lines.push(`fn main(@builtin(vertex_index) vertex_index : u32, @builtin(instance_index) instance_index : u32) -> ${retType} {`);
        if (this.allUsedBuiltins.has('vertex_index')) lines.push(`  VertexIndex = vertex_index;`);
        if (this.allUsedBuiltins.has('instance_index')) lines.push(`  InstanceIndex = instance_index;`);
        for (const input of func.inputs) {
          if (input.builtin === 'vertex_index') lines.push(`  let l_${input.id} = i32(vertex_index);`);
          else if (input.builtin === 'instance_index') lines.push(`  let l_${input.id} = i32(instance_index);`);
        }
      } else if (options.stage === 'fragment') {
        const stageArgs: string[] = [];
        let locationIdx = 0;
        for (const input of func.inputs) {
          if (input.builtin === 'frag_coord') stageArgs.push(`@builtin(frag_coord) fc : vec4<f32>`);
          else if (input.builtin === 'front_facing') stageArgs.push(`@builtin(front_facing) ff : bool`);
          else if (input.builtin === 'sample_index') stageArgs.push(`@builtin(sample_index) si : u32`);
          else if (input.builtin === 'position') stageArgs.push(`@builtin(position) pos : vec4<f32>`);
          else {
            const isStruct = ir.structs.some(s => s.id === input.type);
            const decorators = isStruct ? '' : `@location(${input.location !== undefined ? input.location : locationIdx++}) `;
            stageArgs.push(`${decorators}${input.id} : ${this.resolveType(input.type)}`);
          }
        }
        let retType = 'vec4<f32>';
        let retDecorators = '@location(0)';
        if (func.outputs.length > 0) {
          const out = func.outputs[0];
          retType = this.resolveType(out.type);
          // If it's a struct, we don't put @location(0) on the entry point return itself,
          // because the struct members already have decorators.
          if (ir.structs.some(s => s.id === out.type)) {
            retDecorators = '';
          } else if (out.location !== undefined) {
            retDecorators = `@location(${out.location})`;
          }
        }
        lines.push(`@fragment`);
        lines.push(`fn main(${stageArgs.join(', ')}) -> ${retDecorators} ${retType} {`);
        if (this.allUsedBuiltins.has('frag_coord')) lines.push(`  FragCoord = fc;`);
        if (this.allUsedBuiltins.has('front_facing')) lines.push(`  FrontFacing = ff;`);
        if (this.allUsedBuiltins.has('sample_index')) lines.push(`  SampleIndex = si;`);
        if (this.allUsedBuiltins.has('position')) lines.push(`  Position = pos;`);
        for (const input of func.inputs) {
          if (input.builtin === 'frag_coord') lines.push(`  let l_${input.id} = fc;`);
          if (input.builtin === 'front_facing') lines.push(`  let l_${input.id} = ff;`);
          if (input.builtin === 'sample_index') lines.push(`  let l_${input.id} = i32(si);`);
          if (input.builtin === 'position') lines.push(`  let l_${input.id} = pos;`);
        }
      } else {
        const computeBuiltins: string[] = [`@builtin(global_invocation_id) gid : vec3<u32>`];
        if (this.allUsedBuiltins.has('local_invocation_id')) computeBuiltins.push(`@builtin(local_invocation_id) lid : vec3<u32>`);
        if (this.allUsedBuiltins.has('workgroup_id')) computeBuiltins.push(`@builtin(workgroup_id) wid : vec3<u32>`);
        if (this.allUsedBuiltins.has('local_invocation_index')) computeBuiltins.push(`@builtin(local_invocation_index) lidx : u32`);
        if (this.allUsedBuiltins.has('num_workgroups')) computeBuiltins.push(`@builtin(num_workgroups) nw : vec3<u32>`);
        lines.push(`@compute @workgroup_size(1, 1, 1)`);
        lines.push(`fn main(${computeBuiltins.join(', ')}) {`);
        if (this.allUsedBuiltins.has('global_invocation_id')) lines.push(`  GlobalInvocationID = gid;`);
        if (this.allUsedBuiltins.has('local_invocation_id')) lines.push(`  LocalInvocationID = lid;`);
        if (this.allUsedBuiltins.has('workgroup_id')) lines.push(`  WorkgroupID = wid;`);
        if (this.allUsedBuiltins.has('local_invocation_index')) lines.push(`  LocalInvocationIndex = lidx;`);
        if (this.allUsedBuiltins.has('num_workgroups')) lines.push(`  NumWorkgroups = nw;`);
        for (const input of func.inputs) {
          if (input.builtin === 'global_invocation_id') lines.push(`  let l_${input.id} = GlobalInvocationID;`);
        }
      }
    } else {
      const args = func.inputs.map(arg => `${arg.id}: ${this.resolveType(arg.type)}`).join(', ');
      let retType = 'void';
      if (func.outputs.length === 1) retType = this.resolveType(func.outputs[0].type);
      lines.push(`fn ${func.id}(${args})${retType === 'void' ? '' : ' -> ' + retType} {`);
    }

    func.localVars.forEach(v => {
      const type = this.resolveType(v.type);
      const init = v.initialValue !== undefined ? this.formatLiteral(v.initialValue, v.type) : this.formatZero(v.type);
      lines.push(`  var l_${v.id} : ${type} = ${init};`);
    });

    this.emitBody(func, lines, options, new Set(), ir);
    lines.push(`}`);
  }

  private emitBody(func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>, ir: IRDocument) {
    const entryNodes = func.nodes.filter(n => !func.edges.some(e => e.to === n.id && e.type === 'execution') && this.isExecutable(n.op));
    for (const entry of entryNodes) this.emitChain(entry, func, lines, options, visited, ir);
  }

  private isExecutable(op: string) {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' || op === 'buffer_store' || op === 'texture_store' || op === 'call_func' || op === 'func_return' || op === 'array_set' || op === 'vec_set_element';
  }

  private emitChain(startNode: Node, func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>, ir: IRDocument) {
    let curr: Node | undefined = startNode;
    while (curr) {
      if (visited.has(curr.id)) break;
      visited.add(curr.id);
      this.emitNode(curr, func, lines, options, ir);
      if (curr.op === 'flow_branch') break;
      const edge = func.edges.find(e => e.from === curr!.id && e.portOut === 'exec_out' && e.type === 'execution');
      curr = edge ? func.nodes.find(n => n.id === edge.to) : undefined;
    }
  }

  private emitNode(node: Node, func: FunctionDef, lines: string[], options: WgslOptions, ir: IRDocument) {
    const indent = '  ';
    if (node.op === 'var_set') {
      const varId = node['var'];
      const valExpr = this.resolveArg(node, 'val', func, options, ir);
      if (options.varMap?.has(varId)) {
        const idx = options.varMap.get(varId)!;
        const type = options.varTypes?.get(varId) || 'float';
        const count = this.getComponentCount(type);
        if (count === 1) lines.push(`  b_globals.data[${idx}] = ${valExpr};`);
        else {
          for (let i = 0; i < count; i++) lines.push(`  b_globals.data[${idx + i}] = ${valExpr}[${i}];`);
        }
      } else if (func.localVars.some(v => v.id === varId)) lines.push(`  l_${varId} = ${valExpr};`);
    } else if (node.op === 'array_set' || node.op === 'vec_set_element') {
      const arr = this.resolveArg(node, 'array' in node ? 'array' : 'vec', func, options, ir);
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int');
      const val = this.resolveArg(node, 'value', func, options, ir);
      lines.push(`${indent}${arr}[u32(${idx})] = ${val};`);
    } else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'] as string;
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int');
      const val = this.resolveArg(node, 'value', func, options, ir);
      const bufVar = this.getBufferVar(bufferId);
      const def = options.resourceDefs?.get(bufferId);
      const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
      lines.push(`${indent}${bufVar}.data[u32(${idx})] = ${type}(${val});`);
    } else if (node.op === 'call_func') {
      const targetFunc = ir.functions.find(f => f.id === node['func']);
      if (targetFunc) {
        const args = targetFunc.inputs.map(inp => this.resolveArg(node, inp.id, func, options, ir)).join(', ');
        if (targetFunc.outputs.length > 0) lines.push(`${indent}let v_${node.id} = ${node['func']}(${args});`);
        else lines.push(`${indent}${node['func']}(${args});`);
      }
    } else if (node.op === 'func_return') {
      lines.push(`${indent}return ${this.resolveArg(node, 'value', func, options, ir)};`);
    } else if (node.op === 'flow_branch') {
      const cond = this.resolveArg(node, 'cond', func, options, ir);
      const condExpr = (cond === 'true' || cond === 'false' || cond.includes('==') || cond.includes('!=')) ? cond : `${cond} != 0.0`;
      lines.push(`${indent}if (${condExpr}) {`);
      const trueEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_true');
      if (trueEdge) {
        const trueNode = func.nodes.find(n => n.id === trueEdge.to);
        if (trueNode) this.emitChain(trueNode, func, lines, options, new Set(), ir);
      }
      lines.push(`${indent}} else {`);
      const falseEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_false');
      if (falseEdge) {
        const falseNode = func.nodes.find(n => n.id === falseEdge.to);
        if (falseNode) this.emitChain(falseNode, func, lines, options, new Set(), ir);
      }
      lines.push(`${indent}}`);
    } else if (node.op === 'flow_loop') {
      const start = this.resolveArg(node, 'start', func, options, ir);
      const end = this.resolveArg(node, 'end', func, options, ir);
      const loopVar = `i_${node.id}`;
      lines.push(`${indent}for (var ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);
      const bodyEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_body');
      if (bodyEdge) {
        const bodyNode = func.nodes.find(n => n.id === bodyEdge.to);
        if (bodyNode) this.emitChain(bodyNode, func, lines, options, new Set(), ir);
      }
      lines.push(`${indent}}`);
      const compEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_completed');
      if (compEdge) {
        const compNode = func.nodes.find(n => n.id === compEdge.to);
        if (compNode) this.emitChain(compNode, func, lines, options, new Set(), ir);
      }
    } else if (node.op === 'texture_store') {
      const coords = this.resolveArg(node, 'coords', func, options, ir);
      const val = this.resolveArg(node, 'value', func, options, ir);
      lines.push(`${indent}textureStore(${node['tex']}, vec2<i32>(${coords}.xy), ${val});`);
    } else if (node.op === 'buffer_store') {
      // Already handled above? Wait, I have two buffer_store blocks.
      // I'll clean up.
    } else {
      lines.push(`${indent}// Op: ${node.op}`);
    }
  }

  private getBufferVar(id: string): string {
    if (!id) return 'b_unknown';
    const tid = id.trim();
    if (/^[bB]_/.test(tid)) return tid;
    return `b_${tid}`;
  }

  private getVariableExpr(varId: string, func: FunctionDef, options: WgslOptions): string {
    if (func.localVars.some(v => v.id === varId)) return `l_${varId}`;
    if (options.varMap?.has(varId)) {
      const idx = options.varMap.get(varId)!;
      const type = options.varTypes?.get(varId) || 'float';
      const count = this.getComponentCount(type);
      if (count === 1) return `b_globals.data[${idx}]`;
      if (type === 'float2' || type === 'vec2<f32>') return `vec2<f32>(b_globals.data[${idx}], b_globals.data[${idx + 1}])`;
      if (type === 'float3' || type === 'vec3<f32>') return `vec3<f32>(b_globals.data[${idx}], b_globals.data[${idx + 1}], b_globals.data[${idx + 2}])`;
      if (type === 'float4' || type === 'vec4<f32>') return `vec4<f32>(b_globals.data[${idx}], b_globals.data[${idx + 1}], b_globals.data[${idx + 2}], b_globals.data[${idx + 3}])`;
      if (type === 'float3x3' || type === 'mat3x3<f32>') {
        const comps = [];
        for (let i = 0; i < 9; i++) comps.push(`b_globals.data[${idx + i}]`);
        return `mat3x3<f32>(${comps.join(', ')})`;
      }
      if (type === 'float4x4' || type === 'mat4x4<f32>') {
        const comps = [];
        for (let i = 0; i < 16; i++) comps.push(`b_globals.data[${idx + i}]`);
        return `mat4x4<f32>(${comps.join(', ')})`;
      }
      return `b_globals.data[${idx}]`;
    }
    const arg = func.inputs.find(i => i.id === varId);
    if (arg) {
      if (arg.builtin) return `l_${varId}`;
      const isEntry = options.entryPointId === func.id;
      if (isEntry && options.inputBinding !== undefined) {
        const expr = `b_inputs.${varId}`;
        return arg.type === 'bool' ? `bool(${expr})` : expr;
      }
      return varId;
    }
    return varId;
  }

  private resolveArg(node: Node, key: string, func: FunctionDef, options: WgslOptions, ir: IRDocument, targetType?: string): string {
    const keys = (key === 'val' || key === 'value') ? ['val', 'value'] : [key];
    let edge: Edge | undefined;
    for (const k of keys) {
      edge = func.edges.find(e => e.to === node.id && e.portIn === k && e.type === 'data');
      if (edge) break;
    }

    if (edge) {
      const src = func.nodes.find(n => n.id === edge.from);
      if (src) {
        if (src.op === 'call_func') return `v_${src.id}`;
        if (src.op === 'var_get') return this.getVariableExpr(src['var'], func, options);
        return this.compileExpression(src, func, options, ir, targetType);
      }
    }

    for (const k of keys) {
      if (node[k] !== undefined) {
        const val = node[k];
        if (typeof val === 'string' && val.trim() !== '') {
          const tid = val.trim();
          if (func.localVars.some(v => v.id === tid) || func.inputs.some(i => i.id === tid) || options.varMap?.has(tid)) {
            return this.getVariableExpr(tid, func, options);
          }
          const targetNode = func.nodes.find(n => n.id === tid);
          if (targetNode && targetNode.id !== node.id) return this.compileExpression(targetNode, func, options, ir, targetType);
        }
        return this.formatLiteral(val, targetType || 'unknown');
      }
    }
    return this.formatZero(targetType || 'float');
  }

  private compileExpression(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument, targetType?: string | DataType): string {
    if (node.op === 'literal') return this.formatLiteral(node['val'], targetType || 'float');
    if (node.op === 'loop_index') return `i_${node['loop']}`;
    if (node.op === 'float2') return `vec2<f32>(f32(${this.resolveArg(node, 'x', func, options, ir, 'float')}), f32(${this.resolveArg(node, 'y', func, options, ir, 'float')}))`;
    if (node.op === 'float3') return `vec3<f32>(f32(${this.resolveArg(node, 'x', func, options, ir, 'float')}), f32(${this.resolveArg(node, 'y', func, options, ir, 'float')}), f32(${this.resolveArg(node, 'z', func, options, ir, 'float')}))`;
    if (node.op === 'float4' || node.op === 'quat') return `vec4<f32>(f32(${this.resolveArg(node, 'x', func, options, ir, 'float')}), f32(${this.resolveArg(node, 'y', func, options, ir, 'float')}), f32(${this.resolveArg(node, 'z', func, options, ir, 'float')}), f32(${this.resolveArg(node, 'w', func, options, ir, 'float')}))`;
    if (node.op === 'float3x3' || node.op === 'float4x4') {
      const vals = node['vals'] as number[];
      if (vals) {
        const formatted = vals.map(v => this.formatLiteral(v, 'float'));
        return `${node.op === 'float3x3' ? 'mat3x3<f32>' : 'mat4x4<f32>'}(${formatted.join(', ')})`;
      }
    }
    if (node.op === 'static_cast_float') return `f32(${this.resolveArg(node, 'val', func, options, ir, 'float')})`;
    if (node.op === 'static_cast_int') return `i32(${this.resolveArg(node, 'val', func, options, ir, 'int')})`;
    if (node.op === 'struct_construct') {
      const type = node['type'];
      const structDef = ir.structs?.find(s => s.id === type);
      const args = structDef ? structDef.members.map(m => this.resolveArg(node, m.name, func, options, ir)) : [];
      return `${type}(${args.join(', ')})`;
    }
    if (node.op === 'array_construct') {
      if (node['values']) {
        const vals = node['values'] as any[];
        let type = 'f32';
        if (vals.length > 0) {
          // Check if ANY element is f32 (contains dot or is not integer)
          const hasFloat = vals.some(v => typeof v === 'number' && !Number.isInteger(v));
          if (!hasFloat) {
            if (typeof vals[0] === 'number') type = 'i32';
            else if (typeof vals[0] === 'boolean') type = 'bool';
          }
        }
        return `array<${type}, ${vals.length}>(${vals.map(v => this.formatLiteral(v, type)).join(', ')})`;
      }
      const len = node['length'];
      const fillExpr = this.resolveArg(node, 'fill', func, options, ir);
      const vals = new Array(len).fill(null).map(() => fillExpr);
      return `array<f32, ${len}>(${vals.join(', ')})`;
    }
    if (node.op === 'array_length') {
      const arr = this.resolveArg(node, 'array', func, options, ir);
      return `i32(arrayLength(&${arr}))`;
    }
    if (node.op === 'texture_sample') {
      const tex = node['tex'];
      const uv = (node['uv'] !== undefined) ? this.resolveArg(node, 'uv', func, options, ir) : this.resolveArg(node, 'coords', func, options, ir);
      return `sample_${tex}(${uv})`;
    }
    if (node.op === 'texture_load') {
      const tex = node['tex'];
      const coords = this.resolveArg(node, 'coords', func, options, ir);
      return `textureLoad(${tex}, vec2<i32>(${coords}.xy), 0)`;
    }
    if (node.op === 'resource_get_size') {
      const resId = node['resource'];
      const def = options.resourceDefs?.get(resId);
      if (def?.type === 'texture2d') return `vec2<f32>(textureDimensions(${resId}))`;
      if (def?.type === 'buffer') return `vec2<f32>(f32(arrayLength(&${this.getBufferVar(resId)}.data)), 0.0)`;
      return `vec2<f32>(0.0, 0.0)`;
    }
    if (node.op === 'resource_get_format') {
      // Formats are mostly static string metadata in IR, hard to represent in WGSL return value
      // but we return 0.0 or a dummy value.
      return `0.0`;
    }
    if (node.op === 'buffer_load') {
      const bufferId = node['buffer'] as string;
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int');
      const bufVar = this.getBufferVar(bufferId);
      const def = options.resourceDefs?.get(bufferId);
      const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
      return `${type}(${bufVar}.data[u32(${idx})])`;
    }
    if (node.op === 'color_mix') {
      this.addHelper(`fn color_mix_impl(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  let outA = src.a + dst.a * (1.0 - src.a);
  if (outA < 1e-6) { return vec4<f32>(0.0); }
  return vec4<f32>((src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / outA, outA);
}`);
      return `color_mix_impl(${this.resolveArg(node, 'a', func, options, ir, 'float4')}, ${this.resolveArg(node, 'b', func, options, ir, 'float4')})`;
    }
    if (node.op === 'vec_swizzle') {
      const vec = this.resolveArg(node, 'vec', func, options, ir);
      const swizzle = node['swizzle'] || node['channels'];
      return `${vec}.${swizzle}`;
    }
    if (node.op === 'vec_get_element' || node.op === 'array_extract') {
      const vec = this.resolveArg(node, 'vec' in node ? 'vec' : 'array', func, options, ir);
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int');

      // Matrix target detection for flat array access
      const targetId = (node['vec'] || node['array']) as string;
      if (targetId) {
        const targetIn = func.inputs.find(i => i.id === targetId);
        const targetVar = func.localVars.find(v => v.id === targetId);
        const t = (targetIn?.type || targetVar?.type || '').toLowerCase();
        if (t === 'float3x3' || t === 'mat3x3<f32>') {
          return `${vec}[u32(${idx} / 3)][u32(${idx} % 3)]`;
        } else if (t === 'float4x4' || t === 'mat4x4<f32>') {
          return `${vec}[u32(${idx} / 4)][u32(${idx} % 4)]`;
        }
      }

      return `${vec}[u32(${idx})]`;
    }
    if (node.op === 'vec_set_element' || node.op === 'array_set') {
      const vec = this.resolveArg(node, 'vec' in node ? 'vec' : 'array', func, options, ir);
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int');
      const val = this.resolveArg(node, 'value', func, options, ir);
      return `${vec}[u32(${idx})] = ${val}`; // Note: used as statement in emitNode
    }
    if (node.op === 'mat_extract') {
      const mat = this.resolveArg(node, 'mat', func, options, ir);
      const row = this.resolveArg(node, 'row', func, options, ir, 'int');
      const col = this.resolveArg(node, 'col', func, options, ir, 'int');
      return `${mat}[u32(${col})][u32(${row})]`;
    }
    if (node.op === 'struct_extract') {
      const struct = this.resolveArg(node, 'struct', func, options, ir);
      const member = node['member'] || node['name'] || node['field'];
      if (!member) return `${struct}.undefined_member`;
      return `${struct}.${member}`;
    }
    if (node.op === 'builtin_get') {
      const name = node['name'];
      const builtinVarNames: Record<string, string> = {
        'global_invocation_id': 'GlobalInvocationID', 'local_invocation_id': 'LocalInvocationID',
        'workgroup_id': 'WorkgroupID', 'local_invocation_index': 'LocalInvocationIndex',
        'num_workgroups': 'NumWorkgroups', 'position': 'Position', 'frag_coord': 'FragCoord',
        'front_facing': 'FrontFacing', 'sample_index': 'SampleIndex', 'vertex_index': 'VertexIndex', 'instance_index': 'InstanceIndex'
      };
      return builtinVarNames[name] || name;
    }
    if (this.isMathOp(node.op)) return this.compileMath(node, func, options, ir);
    return '0.0';
  }

  private isMathOp(op: string) { return op.startsWith('math_') || op.startsWith('vec_') || op.startsWith('quat_'); }

  private compileMath(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument): string {
    const op = node.op;
    const isFloatOp = !op.includes('_gt') && !op.includes('_lt') && !op.includes('_ge') && !op.includes('_le') && !op.includes('_eq') && !op.includes('_neq') && !op.startsWith('bits_');

    const a = (k = 'a') => isFloatOp ? `f32(${this.resolveArg(node, k, func, options, ir)})` : this.resolveArg(node, k, func, options, ir);
    const b = (k = 'b') => isFloatOp ? `f32(${this.resolveArg(node, k, func, options, ir)})` : this.resolveArg(node, k, func, options, ir);
    const val = (k = 'val') => isFloatOp ? `f32(${this.resolveArg(node, k, func, options, ir)})` : this.resolveArg(node, k, func, options, ir);

    // Core Arithmetic
    if (op === 'math_add') return `(${a()} + ${b()})`;
    if (op === 'math_sub') return `(${a()} - ${b()})`;
    if (op === 'math_mul') return `(${a()} * ${b()})`;
    if (op === 'math_div') return `(${a()} / ${b()})`;
    if (op === 'math_mod') return `(${a()} % ${b()})`;
    if (op === 'math_neg') return `(-${val()})`;

    // Standard Math
    if (op === 'math_abs') return `abs(${val()})`;
    if (op === 'math_sin') return `sin(${val()})`;
    if (op === 'math_cos') return `cos(${val()})`;
    if (op === 'math_tan') return `tan(${val()})`;
    if (op === 'math_asin') return `asin(${val()})`;
    if (op === 'math_acos') return `acos(${val()})`;
    if (op === 'math_atan') return `atan(${val()})`;
    if (op === 'math_asinh') return `asinh(${val()})`;
    if (op === 'math_acosh') return `acosh(${val()})`;
    if (op === 'math_atanh') return `atanh(${val()})`;
    if (op === 'math_sinh') return `sinh(${val()})`;
    if (op === 'math_cosh') return `cosh(${val()})`;
    if (op === 'math_tanh') return `tanh(${val()})`;

    if (op === 'math_sqrt') return `sqrt(${val()})`;
    if (op === 'math_exp') return `exp(${val()})`;
    if (op === 'math_log') return `log(${val()})`;
    if (op === 'math_pow') return `pow(${a()}, ${b()})`;

    if (op === 'math_trunc') return `trunc(${val()})`;
    if (op === 'math_round') return `round(${val()})`;
    if (op === 'math_floor') return `floor(${val()})`;
    if (op === 'math_ceil') return `ceil(${val()})`;
    if (op === 'math_fract') return `fract(${val()})`;
    if (op === 'math_sign') return `sign(${val()})`;

    if (op === 'math_min') return `min(${a()}, ${b()})`;
    if (op === 'math_max') return `max(${a()}, ${b()})`;
    if (op === 'math_clamp') return `clamp(${val()}, ${this.resolveArg(node, 'min', func, options, ir)}, ${this.resolveArg(node, 'max', func, options, ir)})`;
    if (op === 'math_mix') return `mix(${a()}, ${b()}, ${this.resolveArg(node, 't', func, options, ir)})`;
    if (op === 'math_step') return `step(${this.resolveArg(node, 'edge', func, options, ir)}, ${val()})`;
    if (op === 'math_smoothstep') return `smoothstep(${this.resolveArg(node, 'edge0', func, options, ir)}, ${this.resolveArg(node, 'edge1', func, options, ir)}, ${val()})`;

    // Advanced Math / Bits
    if (op === 'math_frexp_mantissa' || op === 'math_mantissa') return `frexp(${val()}).fract`;
    if (op === 'math_frexp_exponent' || op === 'math_exponent') return `f32(frexp(${val()}).exp)`;
    if (op === 'math_ldexp') return `ldexp(f32(${this.resolveArg(node, 'fract', func, options, ir)}), i32(${this.resolveArg(node, 'exp', func, options, ir)}))`;
    if (op === 'math_flush_subnormal') {
      const v = val();
      return `select(${v}, 0.0, abs(${v}) < 1.17549435e-38)`;
    }

    // Comparison & Logic
    if (op === 'math_is_nan') return `isnan(${val()})`;
    if (op === 'math_is_inf') return `isinf(${val()})`;
    if (op === 'math_is_finite') return `isfinite(${val()})`;

    if (op === 'math_gt') return `(${a()} > ${b()})`;
    if (op === 'math_lt') return `(${a()} < ${b()})`;
    if (op === 'math_ge') return `(${a()} >= ${b()})`;
    if (op === 'math_le') return `(${a()} <= ${b()})`;
    if (op === 'math_eq') return `(${a()} == ${b()})`;
    if (op === 'math_neq') return `(${a()} != ${b()})`;

    // Vectors
    if (op === 'vec_dot') return `dot(${a()}, ${b()})`;
    if (op === 'vec_cross') return `cross(${a()}, ${b()})`;
    if (op === 'vec_length') return `length(${a()})`;
    if (op === 'vec_normalize') return `normalize(${a()})`;
    if (op === 'vec_distance') return `distance(${a()}, ${b()})`;
    if (op === 'vec_reflect') return `reflect(${a()}, ${b()})`;
    if (op === 'vec_refract') return `refract(${a()}, ${b()}, ${this.resolveArg(node, 'eta', func, options, ir)})`;

    return '0.0';
    return '0.0';
  }

  private resolveType(type: DataType | string): string {
    if (type === 'float') return 'f32';
    if (type === 'int') return 'i32';
    if (type === 'bool') return 'bool';
    if (type === 'float2') return 'vec2<f32>';
    if (type === 'float3') return 'vec3<f32>';
    if (type === 'float4') return 'vec4<f32>';
    if (type === 'float3x3') return 'mat3x3<f32>';
    if (type === 'float4x4') return 'mat4x4<f32>';
    if (type === 'string') throw new Error('Shaders do not support string type');

    // Handle array types: float[3] or array<float, 3> or float[]
    if (type.includes('[') || type.startsWith('array<')) {
      const match = type.match(/(\w+)\[(\d*)\]/);
      if (match) {
        const inner = match[1];
        const len = match[2];
        return len ? `array<${this.resolveType(inner)}, ${len}>` : `array<${this.resolveType(inner)} > `;
      }
      return type.replace(/\bfloat\b/g, 'f32').replace(/\bint\b/g, 'i32');
    }

    return type.replace(/\bfloat\b/g, 'f32').replace(/\bint\b/g, 'i32');
  }

  private getComponentCount(type: DataType | string): number {
    if (type === 'float2' || type === 'vec2<f32>') return 2;
    if (type === 'float3' || type === 'vec3<f32>') return 3;
    if (type === 'float4' || type === 'vec4<f32>' || type === 'quat') return 4;
    if (type === 'float3x3' || type === 'mat3x3<f32>') return 9;
    if (type === 'float4x4' || type === 'mat4x4<f32>') return 16;
    return 1;
  }

  private formatLiteral(val: any, type: string | DataType): string {
    if (typeof val === 'number') {
      // For integer types in WGSL, no decimal points allowed
      if (type === 'int' || type === 'i32' || type === 'u32' || type === 'uint') {
        return Math.floor(val).toString();
      }
      const s = val.toString();
      return s.includes('.') ? s : s + '.0';
    }
    if (typeof val === 'boolean') return val.toString();
    return val.toString();
  }

  private formatZero(type: string | DataType): string {
    if (type === 'float' || type === 'f32') return '0.0';
    if (type === 'int' || type === 'i32') return '0';
    if (type === 'bool') return 'false';
    if (type === 'float2' || type === 'vec2<f32>') return 'vec2<f32>(0.0)';
    if (type === 'float3' || type === 'vec3<f32>') return 'vec3<f32>(0.0)';
    if (type === 'float4' || type === 'vec4<f32>') return 'vec4<f32>(0.0)';
    return '0.0';
  }

  public static findUsedResources(func: FunctionDef, ir: IRDocument | ResourceDef[]): Set<string> {
    const resources = new Set<string>();
    const allResources = Array.isArray(ir) ? ir : (ir.resources || []);
    const resourceIds = new Set(allResources.map(r => r.id));
    func.nodes.forEach(node => {
      if (node.op === 'buffer_load' || node.op === 'buffer_store') {
        if (node['buffer'] && resourceIds.has(node['buffer'] as string)) resources.add(node['buffer'] as string);
      }
      if (node.op === 'texture_load' || node.op === 'texture_store' || node.op === 'texture_sample') {
        if (node['tex'] && resourceIds.has(node['tex'] as string)) resources.add(node['tex'] as string);
      }
    });
    return resources;
  }
}
