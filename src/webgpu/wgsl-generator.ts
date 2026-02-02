
import { FunctionDef, Node, Edge, DataType, ResourceDef, IRDocument, StructDef } from '../ir/types';
import { reconstructEdges } from '../ir/utils';

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
  workgroupSize?: [number, number, number];
  storageResources?: Set<string>; // Pre-calculated resources used with texture_store
  sampledResources?: Set<string>; // Pre-calculated resources used with texture_sample/texture_load
}

export interface CompilationMetadata {
  resourceBindings: Map<string, number>;
  inputBinding?: number;
  workgroupSize: [number, number, number];
}

export interface CompilationResult {
  code: string;
  metadata: CompilationMetadata;
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
  compileFunctions(functions: FunctionDef[], entryPointId: string, options: WgslOptions = {}, ir?: Partial<IRDocument>): CompilationResult {
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
      functions,
      structs: [],
      ...ir,
      resources: Array.from(options.resourceDefs?.values() || ir?.resources || [])
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

    const emitted = new Set<string>();
    const toEmit = [entryPointId];

    while (toEmit.length > 0) {
      const fid = toEmit.pop()!;
      if (emitted.has(fid)) continue;
      emitted.add(fid);

      const f = functions.find(func => func.id === fid);
      if (f) {
        // Find called functions
        f.nodes.forEach(n => {
          if (n.op === 'call_func' && typeof n.func === 'string') {
            toEmit.push(n.func);
          }
        });
      }
    }

    // Identify used resources and storage/sampled access for reachable functions
    const usedResources = new Set<string>();
    const storageResources = new Set<string>();
    const sampledResources = new Set<string>();
    const finalEmittedFunctions = functions.filter(f => emitted.has(f.id));

    for (const f of finalEmittedFunctions) {
      const used = WgslGenerator.findUsedResources(f, fullIr);
      used.forEach(r => usedResources.add(r));

      // Centralized detection of access modes
      f.nodes.forEach(n => {
        if (n.op === 'texture_store' && typeof n['tex'] === 'string') {
          storageResources.add(n['tex']);
        }
        if ((n.op === 'texture_sample' || n.op === 'texture_load') && typeof n['tex'] === 'string') {
          sampledResources.add(n['tex']);
        }
      });
    }
    options.storageResources = storageResources;
    options.sampledResources = sampledResources;

    for (const f of finalEmittedFunctions) {
      this.emitFunction(f, f.id === entryPointId, functionLines, options, fullIr, finalEmittedFunctions);
      functionLines.push('');
    }

    this.emitTextureSamplers(lines, options, fullIr, usedResources);

    // Assemble final shader code
    const finalLines: string[] = [];
    // diagnostic(off, derivative_uniformity);
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
    const nonBuiltinInputs = inputSource.filter(i => !(i as any).builtin && i.type !== 'texture2d' && i.type !== 'texture_2d');

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
      options.resourceBindings.forEach((bindingIdx, resId) => {
        // We now emit ALL bindings and use placeholders to ensure they are in the layout

        const def = options.resourceDefs?.get(resId);
        if (def?.type === 'buffer' || !def) {
          const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
          const structName = `Buffer_${resId}`;
          finalLines.push(`struct ${structName} { data: array<${type}> }`);
          const bufVar = this.getBufferVar(resId);
          finalLines.push(`@group(0) @binding(${bindingIdx}) var<storage, read_write> ${bufVar} : ${structName};`);
        } else if (def.type === 'texture2d') {
          // Identify if USED as storage IN THIS MODULE (pre-calculated based on reachable functions)
          const isStorage = options.storageResources?.has(resId);
          const isSampled = options.sampledResources?.has(resId);

          if (isStorage) {
            let format = 'rgba8unorm';
            const irFormat = def.format;
            if (typeof irFormat === 'string') {
              const formatMap: Record<string, string> = { 'rgba8': 'rgba8unorm', 'rgba16f': 'rgba16float', 'rgba32f': 'rgba32float', 'r32f': 'r32float' };
              format = formatMap[irFormat] || irFormat;
            }
            // Use read_write if both read and written, otherwise write only
            const mode = isSampled ? 'read_write' : 'write';
            finalLines.push(`@group(0) @binding(${bindingIdx}) var ${resId} : texture_storage_2d<${format}, ${mode}>;`);
          } else {
            finalLines.push(`@group(0) @binding(${bindingIdx}) var ${resId} : texture_2d<f32>;`);
          }
        }
      });
    }
    if (options.resourceBindings && options.resourceBindings.size > 0) finalLines.push('');

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

    const hasInputs = options.stage === 'compute' && options.inputBinding !== undefined && nonBuiltinInputs.length > 0;
    const finalWorkgroupSize = options.workgroupSize || (options.stage === 'compute' ? [16, 16, 1] as [number, number, number] : [1, 1, 1] as [number, number, number]);

    return {
      code: finalLines.join('\n'),
      metadata: {
        resourceBindings: options.resourceBindings || new Map(),
        inputBinding: hasInputs ? options.inputBinding : undefined,
        workgroupSize: finalWorkgroupSize
      }
    };
  }

  compile(ir: IRDocument, entryPointId: string, options: WgslOptions = {}): CompilationResult {
    if (!options.resourceDefs) {
      options.resourceDefs = new Map<string, any>(ir.resources.map(r => [r.id, r]));
      // Also include texture-inputs as resources so resource_get_size works for them
      ir.inputs.forEach(input => {
        if (input.type === 'texture2d' || input.type === 'texture_2d') {
          if (!options.resourceDefs!.has(input.id)) {
            options.resourceDefs!.set(input.id, { ...input, type: 'texture2d' } as any);
          }
        }
      });
    }
    if (!options.stage) options.stage = 'compute';
    if (options.inputBinding === undefined) options.inputBinding = 1;
    if (!options.resourceBindings) {
      options.resourceBindings = new Map();
      let bindingIdx = 2;
      ir.resources.forEach(res => {
        options.resourceBindings!.set(res.id, bindingIdx++);
      });
      // Detect texture-inputs and treat them as resources (consistent with WebGpuExecutor)
      ir.inputs.forEach(input => {
        if ((input.type === 'texture2d' || input.type === 'texture_2d') && !options.resourceBindings!.has(input.id)) {
          options.resourceBindings!.set(input.id, bindingIdx++);
        }
      });
    }
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
        const isSampled = options.sampledResources?.has(id);
        if (!isSampled) return; // Skip helper if never sampled/read

        const isStorage = options.storageResources?.has(id);
        // We emit the helper even for storage textures, because they might be sampled too.
        // The helper uses textureLoad which works for both.

        const wrap = def.sampler?.wrap || 'clamp';
        const filter = def.sampler?.filter || 'nearest';
        const isLinear = filter === 'linear';

        lines.push(`fn sample_${id}(uv: vec2<f32>) -> vec4<f32> {`);
        lines.push(`  let size_f = vec2<f32>(textureDimensions(${id}${isStorage ? "" : ", 0u"}));`);
        lines.push(`  let size_i = vec2<i32>(size_f);`);

        // Wrap Logic
        if (wrap === 'repeat') {
          lines.push(`  let p = fract(uv);`);
        } else if (wrap === 'mirror') {
          lines.push(`  let p = 1.0 - abs(fract(uv * 0.5) * 2.0 - 1.0);`);
        } else {
          lines.push(`  let p = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));`);
        }

        if (isLinear) {
          lines.push(`  let pixel_coords = p * size_f - 0.5;`);
          lines.push(`  let base = vec2<i32>(floor(pixel_coords));`);
          lines.push(`  let f = pixel_coords - vec2<f32>(base);`);

          // Sample 4 points
          const sample = (ox: number, oy: number) => {
            const coord = ox === 0 && oy === 0 ? "base" : `base + vec2<i32>(${ox}, ${oy})`;
            if (wrap === 'repeat') {
              return `textureLoad(${id}, (${coord} % size_i + size_i) % size_i${isStorage ? "" : ", 0u"})`;
            } else {
              return `textureLoad(${id}, clamp(${coord}, vec2<i32>(0), size_i - 1)${isStorage ? "" : ", 0u"})`;
            }
          };

          lines.push(`  let c00 = ${sample(0, 0)};`);
          lines.push(`  let c10 = ${sample(1, 0)};`);
          lines.push(`  let c01 = ${sample(0, 1)};`);
          lines.push(`  let c11 = ${sample(1, 1)};`);
          lines.push(`  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);`);
        } else {
          lines.push(`  let coord = vec2<i32>(floor(p * size_f));`);
          if (wrap === 'repeat') {
            lines.push(`  let sc = (coord % size_i + size_i) % size_i;`);
          } else {
            lines.push(`  let sc = clamp(coord, vec2<i32>(0), size_i - 1);`);
          }
          lines.push(`  return textureLoad(${id}, sc${isStorage ? "" : ", 0u"});`);
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

  private emitPlaceholders(lines: string[], options: WgslOptions, includeInputs: boolean, emittedFunctions: FunctionDef[]) {
    if (options.resourceBindings) {
      options.resourceBindings.forEach((_, resId) => {
        const def = options.resourceDefs?.get(resId);
        if (def?.type === 'texture2d') {
          const isStorage = options.storageResources?.has(resId);
          lines.push(`  _ = textureDimensions(${resId}${isStorage ? "" : ", 0u"});`);
        } else {
          const bufVar = this.getBufferVar(resId);
          lines.push(`  _ = &${bufVar}.data;`);
        }
      });
    }
    if (includeInputs && options.inputBinding !== undefined) {
      lines.push(`  _ = &b_inputs;`);
    }
  }

  private emitFunction(func: FunctionDef, isEntryPoint: boolean, lines: string[], options: WgslOptions, ir: IRDocument, emittedFunctions: FunctionDef[]) {
    const nonBuiltinInputs = func.inputs.filter(i => !(i as any).builtin);

    if (isEntryPoint) {
      if (options.stage === 'vertex') {
        const retType = this.resolveType(func.outputs[0]?.type || 'vec4<f32>');
        lines.push(`@vertex`);
        lines.push(`fn main(@builtin(vertex_index) vertex_index : u32, @builtin(instance_index) instance_index : u32) -> ${retType} {`);
        if (this.allUsedBuiltins.has('vertex_index')) lines.push(`  VertexIndex = vertex_index;`);
        if (this.allUsedBuiltins.has('instance_index')) lines.push(`  InstanceIndex = instance_index;`);

        this.emitPlaceholders(lines, options, false, emittedFunctions);

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

        this.emitPlaceholders(lines, options, false, emittedFunctions);

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

        const wgSize = options.workgroupSize || [16, 16, 1];
        lines.push(`@compute @workgroup_size(${wgSize[0]}, ${wgSize[1]}, ${wgSize[2]})`);
        lines.push(`fn main(${computeBuiltins.join(', ')}) {`);
        if (this.allUsedBuiltins.has('local_invocation_id')) lines.push(`  LocalInvocationID = lid;`);
        if (this.allUsedBuiltins.has('workgroup_id')) lines.push(`  WorkgroupID = wid;`);
        if (this.allUsedBuiltins.has('local_invocation_index')) lines.push(`  LocalInvocationIndex = lidx;`);
        if (this.allUsedBuiltins.has('num_workgroups')) lines.push(`  NumWorkgroups = nw;`);

        this.emitPlaceholders(lines, options, nonBuiltinInputs.length > 0, emittedFunctions);

        for (const input of func.inputs) {
          if (input.builtin === 'global_invocation_id') lines.push(`  let l_${input.id} = gid;`);
          if (input.builtin === 'local_invocation_id') lines.push(`  let l_${input.id} = lid;`);
          if (input.builtin === 'workgroup_id') lines.push(`  let l_${input.id} = wid;`);
          if (input.builtin === 'local_invocation_index') lines.push(`  let l_${input.id} = lidx;`);
          if (input.builtin === 'num_workgroups') lines.push(`  let l_${input.id} = nw;`);
        }
      }
    } else {
      const args = func.inputs.map(arg => `${arg.id}: ${this.resolveType(arg.type)}`).join(', ');
      let retType = 'void';
      if (func.outputs.length === 1) retType = this.resolveType(func.outputs[0].type);
      lines.push(`fn ${func.id}(${args})${retType === 'void' ? '' : ' -> ' + retType} {`);
    }

    const edges = reconstructEdges(func);
    this.emitLocalVars(func, lines);
    this.emitBody(func, lines, options, new Set(), ir, edges);
    lines.push(`}`);
  }

  private emitLocalVars(func: FunctionDef, lines: string[]) {
    for (const v of func.localVars) {
      const type = this.resolveType(v.type);
      let init = '';
      if (v.initialValue !== undefined) {
        init = ` = ${this.formatLiteral(v.initialValue, v.type)}`;
      } else {
        init = ` = ${this.formatZero(v.type)}`;
      }
      lines.push(`  var l_${v.id} : ${type}${init};`);
    }
  }

  private emitBody(func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>, ir: IRDocument, edges: Edge[]) {
    const entryNodes = func.nodes.filter(n => !edges.some(e => e.to === n.id && e.type === 'execution') && this.isExecutable(n.op));
    for (const entry of entryNodes) this.emitChain(entry, func, lines, options, visited, ir, edges);
  }

  private isExecutable(op: string) {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' || op === 'buffer_store' || op === 'texture_store' || op === 'call_func' || op === 'func_return' || op === 'array_set' || op === 'vec_set_element';
  }

  private emitChain(startNode: Node, func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>, ir: IRDocument, edges: Edge[]) {
    let curr: Node | undefined = startNode;
    while (curr) {
      if (visited.has(curr.id)) break;
      visited.add(curr.id);
      this.emitNode(curr, func, lines, options, ir, edges);
      if (curr.op === 'flow_branch') break;
      const edge = edges.find(e => e.from === curr!.id && e.portOut === 'exec_out' && e.type === 'execution');
      curr = edge ? func.nodes.find(n => n.id === edge.to) : undefined;
    }
  }

  private emitNode(node: Node, func: FunctionDef, lines: string[], options: WgslOptions, ir: IRDocument, edges: Edge[]) {
    const indent = '  ';
    if (node.op === 'var_set') {
      const varId = node['var'];
      const valExpr = this.resolveArg(node, 'val', func, options, ir, 'float', edges);
      if (options.varMap?.has(varId)) {
        const idx = options.varMap.get(varId)!;
        const type = options.varTypes?.get(varId) || 'float';
        const isMatrix = type.includes('x');
        const count = this.getComponentCount(type);

        if (count === 1) {
          lines.push(`  b_globals.data[${idx}] = ${valExpr};`);
        } else if (isMatrix) {
          const dims = type.includes('3x3') ? 3 : 4;
          for (let c = 0; c < dims; c++) {
            for (let r = 0; r < dims; r++) {
              lines.push(`  b_globals.data[${idx + c * dims + r}] = ${valExpr}[${c}][${r}];`);
            }
          }
        } else {
          for (let i = 0; i < count; i++) {
            lines.push(`  b_globals.data[${idx + i}] = ${valExpr}[${i}];`);
          }
        }
      } else if (func.localVars.some(v => v.id === varId)) {
        lines.push(`  l_${varId} = ${valExpr};`);
      }
    } else if (node.op === 'array_set' || node.op === 'vec_set_element') {
      const arr = this.resolveArg(node, 'array' in node ? 'array' : 'vec', func, options, ir, 'any', edges);
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int', edges);
      const val = this.resolveArg(node, 'value', func, options, ir, 'any', edges);
      lines.push(`${indent}${arr}[u32(${idx})] = ${val};`);
    } else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'] as string;
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int', edges);
      const val = this.resolveArg(node, 'value', func, options, ir, 'any', edges);
      const bufVar = this.getBufferVar(bufferId);
      const def = options.resourceDefs?.get(bufferId);
      const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
      lines.push(`${indent}${bufVar}.data[u32(${idx})] = ${type}(${val});`);
    } else if (node.op === 'call_func') {
      const targetFunc = ir.functions.find(f => f.id === node['func']);
      if (targetFunc) {
        const args = targetFunc.inputs.map(inp => this.resolveArg(node, inp.id, func, options, ir, 'any', edges)).join(', ');
        if (targetFunc.outputs.length > 0) lines.push(`${indent}let v_${node.id} = ${node['func']}(${args});`);
        else lines.push(`${indent}${node['func']}(${args});`);
      }
    } else if (node.op === 'func_return') {
      lines.push(`${indent}return ${this.resolveArg(node, 'value', func, options, ir, 'any', edges)};`);
    } else if (node.op === 'flow_branch') {
      const cond = this.resolveArg(node, 'cond', func, options, ir, 'any', edges);
      const condExpr = (cond === 'true' || cond === 'false' || cond.includes('==') || cond.includes('!=')) ? cond : `${cond} != 0.0`;
      lines.push(`${indent}if (${condExpr}) {`);
      const trueEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_true');
      if (trueEdge) {
        const trueNode = func.nodes.find(n => n.id === trueEdge.to);
        if (trueNode) this.emitChain(trueNode, func, lines, options, new Set(), ir, edges);
      }
      lines.push(`${indent}} else {`);
      const falseEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_false');
      if (falseEdge) {
        const falseNode = func.nodes.find(n => n.id === falseEdge.to);
        if (falseNode) this.emitChain(falseNode, func, lines, options, new Set(), ir, edges);
      }
      lines.push(`${indent}}`);
    } else if (node.op === 'flow_loop') {
      const start = this.resolveArg(node, 'start', func, options, ir, 'int', edges);
      const end = this.resolveArg(node, 'end', func, options, ir, 'int', edges);
      const loopVar = `i_${node.id}`;
      lines.push(`${indent}for (var ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);
      const bodyEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_body');
      if (bodyEdge) {
        const bodyNode = func.nodes.find(n => n.id === bodyEdge.to);
        if (bodyNode) this.emitChain(bodyNode, func, lines, options, new Set(), ir, edges);
      }
      lines.push(`${indent}}`);
      const compEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_completed');
      if (compEdge) {
        const compNode = func.nodes.find(n => n.id === compEdge.to);
        if (compNode) this.emitChain(compNode, func, lines, options, new Set(), ir, edges);
      }
    } else if (node.op === 'texture_store') {
      const coords = this.resolveArg(node, 'coords', func, options, ir, 'any', edges);
      const val = this.resolveArg(node, 'value', func, options, ir, 'any', edges);
      lines.push(`${indent}textureStore(${node['tex']}, vec2<i32>(${coords}), ${val});`);
    } else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'] as string;
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int', edges);
      const val = this.resolveArg(node, 'value', func, options, ir, 'any', edges);
      const bufVar = this.getBufferVar(bufferId);
      const def = options.resourceDefs?.get(bufferId);
      const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
      lines.push(`${indent}${bufVar}.data[u32(${idx})] = ${type}(${val});`);
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

  private resolveArg(node: Node, key: string, func: FunctionDef, options: WgslOptions, ir: IRDocument, targetType: string = 'float', edges: Edge[]): string {
    const keys = (key === 'val' || key === 'value') ? ['val', 'value'] : [key];
    let edge: Edge | undefined;
    for (const k of keys) {
      edge = edges.find(e => e.to === node.id && e.portIn === k && e.type === 'data');
      if (edge) break;
    }

    if (edge) {
      const src = func.nodes.find(n => n.id === edge.from);
      if (src) {
        if (src.op === 'call_func') return `v_${src.id}`;
        if (src.op === 'var_get') return this.getVariableExpr(src['var'], func, options);
        return this.compileExpression(src, func, options, ir, targetType, edges);
      }
    }

    for (const k of keys) {
      let val: any = undefined;
      if (node[k] !== undefined) {
        val = node[k];
      } else {
        const match = k.match(/^(.+)\[(\d+)\]$/);
        if (match) {
          const baseKey = match[1];
          const idx = parseInt(match[2], 10);
          if (Array.isArray(node[baseKey])) val = node[baseKey][idx];
        }
      }

      if (val !== undefined) {
        if (typeof val === 'string' && val.trim() !== '') {
          const tid = val.trim();
          if (func.localVars.some(v => v.id === tid) || func.inputs.some(i => i.id === tid) || options.varMap?.has(tid)) {
            return this.getVariableExpr(tid, func, options);
          }
          const targetNode = func.nodes.find(n => n.id === tid);
          if (targetNode && targetNode.id !== node.id) return this.compileExpression(targetNode, func, options, ir, targetType, edges);
        }
        return this.formatLiteral(val, targetType || 'unknown');
      }
    }
    return this.formatZero(targetType || 'float');
  }

  private compileExpression(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument, targetType: string | DataType = 'float', edges: Edge[]): string {
    if (node.op === 'literal') return this.formatLiteral(node['val'], targetType || 'float');
    if (node.op === 'loop_index') return `i_${node['loop']}`;
    if (node.op === 'float2') return `vec2<f32>(f32(${this.resolveArg(node, 'x', func, options, ir, 'float', edges)}), f32(${this.resolveArg(node, 'y', func, options, ir, 'float', edges)}))`;
    if (node.op === 'float3') return `vec3<f32>(f32(${this.resolveArg(node, 'x', func, options, ir, 'float', edges)}), f32(${this.resolveArg(node, 'y', func, options, ir, 'float', edges)}), f32(${this.resolveArg(node, 'z', func, options, ir, 'float', edges)}))`;
    if (node.op === 'float4' || node.op === 'quat') return `vec4<f32>(f32(${this.resolveArg(node, 'x', func, options, ir, 'float', edges)}), f32(${this.resolveArg(node, 'y', func, options, ir, 'float', edges)}), f32(${this.resolveArg(node, 'z', func, options, ir, 'float', edges)}), f32(${this.resolveArg(node, 'w', func, options, ir, 'float', edges)}))`;
    if (node.op === 'float3x3' || node.op === 'float4x4') {
      const vals = node['vals'] as number[];
      if (vals) {
        const formatted = vals.map(v => this.formatLiteral(v, 'float'));
        return `${node.op === 'float3x3' ? 'mat3x3<f32>' : 'mat4x4<f32>'}(${formatted.join(', ')})`;
      }
    }
    if (node.op === 'mat_identity') {
      const size = node['size'] || 4;
      if (size === 3) return 'mat3x3<f32>(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)';
      return 'mat4x4<f32>(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)';
    }
    if (node.op === 'static_cast_float') return `f32(${this.resolveArg(node, 'val', func, options, ir, 'float', edges)})`;
    if (node.op === 'static_cast_int') return `i32(${this.resolveArg(node, 'val', func, options, ir, 'int', edges)})`;
    if (node.op === 'struct_construct') {
      const type = node['type'];
      const structDef = ir.structs?.find(s => s.id === type);
      const args = structDef ? structDef.members.map(m => this.resolveArg(node, m.name, func, options, ir, 'any', edges)) : [];
      return `${type}(${args.join(', ')})`;
    }
    if (node.op === 'array_construct') {
      const values = node['values'];
      if (Array.isArray(values)) {
        const items = values.map((_, i) => this.resolveArg(node, `values[${i}]`, func, options, ir, 'any', edges));
        if (items.length === 0) return 'array<f32, 0>()';
        // Try to infer type from first resolved item or default to f32
        const type = options.varTypes?.get(values[0]) || 'f32';
        return `array<${this.resolveType(type)}, ${items.length}>(${items.join(', ')})`;
      }
      const len = node['length'] || 0;
      const fillExpr = this.resolveArg(node, 'fill', func, options, ir, 'any', edges);
      const vals = new Array(len).fill(null).map(() => fillExpr);
      return `array<f32, ${len}>(${vals.join(', ')})`;
    }
    if (node.op === 'array_length') {
      const arr = this.resolveArg(node, 'array', func, options, ir, 'any', edges);
      return `i32(arrayLength(&${arr}))`;
    }
    if (node.op === 'texture_sample') {
      const tex = node['tex'];
      const uv = (node['uv'] !== undefined) ? this.resolveArg(node, 'uv', func, options, ir, 'any', edges) : this.resolveArg(node, 'coords', func, options, ir, 'any', edges);
      return `sample_${tex}(${uv})`;
    }
    if (node.op === 'texture_load') {
      const tex = node['tex'];
      const coords = this.resolveArg(node, 'coords', func, options, ir, 'any', edges);
      const isStorage = options.storageResources?.has(tex);
      return `textureLoad(${tex}, vec2<i32>(${coords})${isStorage ? "" : ", 0u"})`;
    }
    if (node.op === 'resource_get_size') {
      const resId = node['resource'];
      const def = options.resourceDefs?.get(resId);
      if (def?.type === 'texture2d') {
        const isStorage = options.storageResources?.has(resId);
        return `vec2<f32>(textureDimensions(${resId}${isStorage ? '' : ', 0u'}))`;
      }
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
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int', edges);
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
      return `color_mix_impl(${this.resolveArg(node, 'a', func, options, ir, 'float4', edges)}, ${this.resolveArg(node, 'b', func, options, ir, 'float4', edges)})`;
    }
    if (node.op === 'vec_swizzle') {
      const vec = this.resolveArg(node, 'vec', func, options, ir, 'any', edges);
      const swizzle = node['swizzle'] || node['channels'];
      return `${vec}.${swizzle}`;
    }
    if (node.op === 'vec_get_element' || node.op === 'array_extract') {
      const vec = this.resolveArg(node, 'vec' in node ? 'vec' : 'array', func, options, ir, 'any', edges);
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int', edges);

      // Matrix target detection for flat array access
      const targetId = (node['vec' as keyof Node] || node['array' as keyof Node]) as string;
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
      const vec = this.resolveArg(node, 'vec' in node ? 'vec' : 'array', func, options, ir, 'any', edges);
      const idx = this.resolveArg(node, 'index', func, options, ir, 'int', edges);
      const val = this.resolveArg(node, 'value', func, options, ir, 'any', edges);
      return `${vec}[u32(${idx})] = ${val}`; // Note: used as statement in emitNode
    }
    if (node.op === 'mat_extract') {
      const mat = this.resolveArg(node, 'mat', func, options, ir, 'any', edges);
      const row = this.resolveArg(node, 'row', func, options, ir, 'int', edges);
      const col = this.resolveArg(node, 'col', func, options, ir, 'int', edges);
      return `${mat}[u32(${col})][u32(${row})]`;
    }
    if (node.op === 'struct_extract') {
      const struct = this.resolveArg(node, 'struct', func, options, ir, 'any', edges);
      const member = node['member'] || node['name'] || node['field'];
      if (!member) return `${struct}.undefined_member`;
      return `${struct}.${member}`;
    }
    if (node.op === 'builtin_get') {
      const name = node['name'];
      if (name === 'global_invocation_id') return 'gid';
      if (name === 'local_invocation_id') return 'lid';
      if (name === 'workgroup_id') return 'wid';
      if (name === 'local_invocation_index') return 'lidx';
      if (name === 'num_workgroups') return 'nw';
      return 'gid';
    }
    if (this.isMathOp(node.op)) return this.compileMath(node, func, options, ir, edges);
    return '0.0';
  }

  private isMathOp(op: string) { return op.startsWith('math_') || op.startsWith('vec_') || op.startsWith('quat_') || op.startsWith('mat_'); }

  private compileMath(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument, edges: Edge[]): string {
    const op = node.op;
    const isFloatOp = !op.includes('_gt') && !op.includes('_lt') && !op.includes('_ge') && !op.includes('_le') && !op.includes('_eq') && !op.includes('_neq') && !op.startsWith('bits_');

    const a = (k = 'a') => {
      const expr = this.resolveArg(node, k, func, options, ir, 'float', edges);
      return (isFloatOp && !expr.includes('vec') && !expr.includes('mat')) ? `f32(${expr})` : expr;
    };
    const b = (k = 'b') => {
      const expr = this.resolveArg(node, k, func, options, ir, 'float', edges);
      return (isFloatOp && !expr.includes('vec') && !expr.includes('mat')) ? `f32(${expr})` : expr;
    };
    const val = (k = 'val') => {
      const expr = this.resolveArg(node, k, func, options, ir, 'float', edges);
      return (isFloatOp && !expr.includes('vec') && !expr.includes('mat')) ? `f32(${expr})` : expr;
    };

    // Core Arithmetic
    if (op === 'math_add') return `(${a()} + ${b()})`;
    if (op === 'math_sub') return `(${a()} - ${b()})`;
    if (op === 'math_mul' || op === 'mat_mul') return `(${a()} * ${b()})`;
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
    if (op === 'math_mad') return `((${a()} * ${b()}) + ${this.resolveArg(node, 'c', func, options, ir, 'float', edges)})`;
    if (op === 'math_clamp') return `clamp(${val()}, ${this.resolveArg(node, 'min', func, options, ir, 'float', edges)}, ${this.resolveArg(node, 'max', func, options, ir, 'float', edges)})`;
    if (op === 'math_mix') return `mix(${a()}, ${b()}, ${this.resolveArg(node, 't', func, options, ir, 'float', edges)})`;
    if (op === 'math_step') return `step(${this.resolveArg(node, 'edge', func, options, ir, 'float', edges)}, ${val()})`;
    if (op === 'math_smoothstep') return `smoothstep(${this.resolveArg(node, 'edge0', func, options, ir, 'float', edges)}, ${this.resolveArg(node, 'edge1', func, options, ir, 'float', edges)}, ${val()})`;

    // Advanced Math / Bits
    if (op === 'math_frexp_mantissa' || op === 'math_mantissa') return `frexp(${val()}).fract`;
    if (op === 'math_frexp_exponent' || op === 'math_exponent') return `f32(frexp(${val()}).exp)`;
    if (op === 'math_ldexp') return `ldexp(f32(${this.resolveArg(node, 'fract', func, options, ir, 'float', edges)}), i32(${this.resolveArg(node, 'exp', func, options, ir, 'int', edges)}))`;
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
    if (op === 'vec_refract') return `refract(${a()}, ${b()}, ${this.resolveArg(node, 'eta', func, options, ir, 'float', edges)})`;

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
    if (Array.isArray(val)) {
      const innerType = type.replace('float', 'f32').replace('int', 'i32');
      const items = val.map(v => this.formatLiteral(v, 'float'));
      if (val.length === 2) return `vec2<f32>(${items.join(', ')})`;
      if (val.length === 3) return `vec3<f32>(${items.join(', ')})`;
      if (val.length === 4) return `vec4<f32>(${items.join(', ')})`;
      if (val.length === 9) return `mat3x3<f32>(${items.join(', ')})`;
      if (val.length === 16) return `mat4x4<f32>(${items.join(', ')})`;
      return `array<f32, ${val.length}>(${items.join(', ')})`;
    }
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
