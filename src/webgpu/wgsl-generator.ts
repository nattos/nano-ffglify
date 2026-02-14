
import { FunctionDef, Node, Edge, DataType, ResourceDef, IRDocument, StructDef, BuiltinOp } from '../ir/types';
import { OpDefs } from '../ir/builtin-schemas';
import { reconstructEdges } from '../ir/utils';
import { ShaderLayout, BufferBlockLayout, StructLayoutInfo } from './shader-layout';
// @ts-ignore
import intrinsicsWgsl from './intrinsics.wgsl?raw';

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
  fullIr?: IRDocument; // Full IR document for global context
  usedBuiltins?: Set<string>;
}

export interface CompilationMetadata {
  resourceBindings: Map<string, number>;
  resourceTypes: Map<string, 'buffer' | 'texture2d'>;
  inputBinding?: number;
  inputLayout?: BufferBlockLayout;
  structLayouts?: Record<string, StructLayoutInfo>;
  workgroupSize: [number, number, number];
}

export interface CompilationResult {
  code: string;
  imports: Record<string, string>;
  metadata: CompilationMetadata;
}

export class WgslGenerator {
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
    if (ir) options.fullIr = ir as IRDocument;
    const entryFunc = functions.find(f => f.id === entryPointId);
    if (!entryFunc) throw new Error(`Entry point function '${entryPointId}' not found`);
    options.entryPointId = entryPointId;

    this.allUsedBuiltins = options.usedBuiltins || new Set<string>();

    if (!options.usedBuiltins) {
      // Fallback: manual scan built-ins across all potential functions
      functions.forEach(f => {
        f.nodes.forEach(n => {
          if (n.op === 'builtin_get') this.allUsedBuiltins.add(n['name']);
        });
      });
    }

    // normalized_global_invocation_id requires gid and num_workgroups to compute
    if (this.allUsedBuiltins.has('normalized_global_invocation_id')) {
      this.allUsedBuiltins.add('global_invocation_id');
      this.allUsedBuiltins.add('num_workgroups');
    }

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

    const lines: string[] = []; // Top-level things: structs, samplers
    const functionLines: string[] = []; // Actual function code

    // 2. Structs
    this.generateStructs(fullIr, lines, options);

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

    // Filter bindings to only used resources
    if (options.resourceBindings) {
      const filtered = new Map<string, number>();
      options.resourceBindings.forEach((binding, id) => {
        if (usedResources.has(id)) filtered.set(id, binding);
      });
      options.resourceBindings = filtered;
    }

    options.storageResources = storageResources;
    options.sampledResources = sampledResources;

    for (const f of finalEmittedFunctions) {
      this.emitFunction(f, f.id === entryPointId, functionLines, options, fullIr, finalEmittedFunctions);
      functionLines.push('');
    }

    this.emitTextureSamplers(lines, options, fullIr, usedResources);

    // Assemble final shader code
    const finalLines: string[] = []; // Collect everything for the final string assembly
    finalLines.push('#import "intrinsics.wgsl"');
    finalLines.push('');

    // Pre-validate
    this.validateRecursion(fullIr.functions || []);

    // 1. Emit Globals struct
    // Check if we have explicit globals in IR OR if we have mapped variables (Compute backend)
    const hasGlobals = (fullIr.globals && fullIr.globals.length > 0) || (options.varMap && options.varMap.size > 0);
    if (hasGlobals) {
      if (options.globalBufferBinding === undefined) options.globalBufferBinding = 0;
      finalLines.push(`struct Globals { data: array<f32> }`);
      finalLines.push(`@group(0) @binding(${options.globalBufferBinding}) var<storage, read_write> b_globals : Globals;`);
      finalLines.push('');
    }

    // 2.5. Inputs Buffer (Uniforms / Non-Stage IO)
    // For shaders, we use both the function's own inputs AND global inputs.
    // This allows shaders to access top-level graph parameters.
    const inputSource = entryFunc.type === 'shader'
      ? [...(fullIr.inputs || []), ...entryFunc.inputs]
      : (fullIr.inputs || []);

    // Deduplicate inputs by ID
    const uniqueInputsMap = new Map();
    inputSource.forEach(i => uniqueInputsMap.set(i.id, i));
    const uniqueInputsList = Array.from(uniqueInputsMap.values());

    const nonBuiltinInputs = uniqueInputsList.filter((i: any) => !i.builtin && i.type !== 'texture2d' && !options.varMap?.has(i.id));

    let inputLayout: BufferBlockLayout | undefined;
    const layout = new ShaderLayout(ir?.structs || []);

    if (options.stage === 'compute' && options.inputBinding !== undefined) {
      const docInputs = [...nonBuiltinInputs];
      // Inject dispatch size for bounds checking - now unconditional for compute
      docInputs.push({ id: 'u_dispatch_size', type: 'vec3<u32>' });

      // Standard built-ins supported via uniform/storage buffer
      const standardBuiltins = ['time', 'delta_time', 'bpm', 'beat_number', 'beat_delta'];
      standardBuiltins.forEach(b => {
        if (this.allUsedBuiltins.has(b)) {
          docInputs.push({ id: b, type: 'float' });
        }
      });

      // Use ShaderLayout to determine order (sort=true for efficient packing)
      // This guarantees the struct layout matches the buffer packing.
      // Use std430 for storage buffers (Inputs)
      inputLayout = layout.calculateBlockLayout(docInputs, true, 'std430');

      finalLines.push('struct Inputs {');
      for (const field of inputLayout.fields) {
        let type = this.resolveType(field.type);
        if (type === 'bool') type = 'u32';
        finalLines.push(`  ${field.name} : ${type},`);
      }
      finalLines.push('}');
      finalLines.push(`@group(0) @binding(${options.inputBinding}) var<storage, read> b_inputs : Inputs;`);
      finalLines.push('');
    }

    // Resource Bindings
    const resourceTypes = new Map<string, 'buffer' | 'texture2d'>();
    if (options.resourceBindings) {
      options.resourceBindings.forEach((bindingIdx, resId) => {
        // We now emit ALL bindings and use placeholders to ensure they are in the layout

        const def = options.resourceDefs?.get(resId);
        if (def?.type === 'buffer' || !def) {
          resourceTypes.set(resId, 'buffer');
          const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
          const structName = `Buffer_${resId}`;
          finalLines.push(`struct ${structName} { data: array<${type}> }`);
          const bufVar = this.getBufferVar(resId);
          finalLines.push(`@group(0) @binding(${bindingIdx}) var<storage, read_write> ${bufVar} : ${structName};`);
        } else if (def.type === 'texture2d') {
          resourceTypes.set(resId, 'texture2d');
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

    // 2.5. Inputs Buffer

    // Global built-ins
    const builtins = ['global_invocation_id', 'local_invocation_id', 'workgroup_id', 'local_invocation_index', 'num_workgroups', 'normalized_global_invocation_id', 'position', 'frag_coord', 'front_facing', 'sample_index', 'vertex_index', 'instance_index'];
    const builtinTypes: Record<string, string> = {
      'global_invocation_id': 'vec3<u32>', 'local_invocation_id': 'vec3<u32>', 'workgroup_id': 'vec3<u32>',
      'local_invocation_index': 'u32', 'num_workgroups': 'vec3<u32>', 'normalized_global_invocation_id': 'vec3<f32>',
      'position': 'vec4<f32>',
      'frag_coord': 'vec4<f32>', 'front_facing': 'bool', 'sample_index': 'u32', 'vertex_index': 'u32', 'instance_index': 'u32'
    };
    const builtinVarNames: Record<string, string> = {
      'global_invocation_id': 'GlobalInvocationID', 'local_invocation_id': 'LocalInvocationID',
      'workgroup_id': 'WorkgroupID', 'local_invocation_index': 'LocalInvocationIndex',
      'num_workgroups': 'NumWorkgroups', 'normalized_global_invocation_id': 'NormalizedGlobalInvocationID',
      'position': 'Position', 'frag_coord': 'FragCoord',
      'front_facing': 'FrontFacing', 'sample_index': 'SampleIndex', 'vertex_index': 'VertexIndex', 'instance_index': 'InstanceIndex'
    };

    builtins.forEach(b => {
      if (this.allUsedBuiltins.has(b)) {
        finalLines.push(`var<private> ${builtinVarNames[b]} : ${builtinTypes[b]};`);
      }
    });

    // Merge everything
    // Put custom user structs (lines) before Inputs/Globals (finalLines) as they may reference them
    const finalCodeLines = [...lines, ...finalLines, ...functionLines];
    const code = finalCodeLines.join('\n');



    const hasInputs = options.inputBinding !== undefined && (
      (options.stage === 'compute') || // Always have u_dispatch_size in compute
      nonBuiltinInputs.length > 0
    );
    const finalWorkgroupSize = options.workgroupSize || (options.stage === 'compute' ? [16, 16, 1] as [number, number, number] : [1, 1, 1] as [number, number, number]);

    return {
      code,
      imports: {
        '#import "intrinsics.wgsl"': intrinsicsWgsl
      },
      metadata: {
        resourceBindings: options.resourceBindings || new Map(),
        resourceTypes,
        inputBinding: hasInputs ? options.inputBinding : undefined,
        inputLayout: hasInputs && inputLayout ? inputLayout : undefined,
        structLayouts: hasInputs && layout ? Object.fromEntries(
          (ir?.structs || []).map(s => [s.id, layout.getStructLayout(s.id, 'std430')])
        ) : undefined,
        workgroupSize: finalWorkgroupSize
      }
    }
  }

  compile(ir: IRDocument, entryPointId: string, options: WgslOptions = {}): CompilationResult {
    if (!options.resourceDefs) {
      options.resourceDefs = new Map<string, any>(ir.resources.map(r => [r.id, r]));
      // Also include texture-inputs as resources so resource_get_size works for them
      ir.inputs.forEach(input => {
        if (input.type === 'texture2d') {
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
        if ((input.type === 'texture2d') && !options.resourceBindings!.has(input.id)) {
          options.resourceBindings!.set(input.id, bindingIdx++);
        }
      });
    }
    // Extract metadata from entry point function
    const entryFunc = ir.functions.find(f => f.id === entryPointId);
    if (entryFunc && entryFunc.metadata && entryFunc.metadata['workgroup_size']) {
      options.workgroupSize = entryFunc.metadata['workgroup_size'] as [number, number, number];
    }

    return this.compileFunctions(ir.functions, entryPointId, options, ir);
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

  private generateStructs(ir: IRDocument, lines: string[], options: WgslOptions) {
    for (const s of ir.structs ?? []) {
      lines.push(`struct ${s.id} {`);
      let locationIdx = 0;
      for (const m of s.members) {
        const type = this.resolveType(m.type);
        let decorators = '';
        if (m.builtin) {
          decorators += `@builtin(${m.builtin}) `;
        } else if (options.stage !== 'compute') {
          // Fragment/Vertex IO requires @location for all non-builtin members
          // But only if we are in Vertex/Fragment stage. Compute doesn't support @location struct members.
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
            const isStruct = (ir.structs ?? []).some(s => s.id === input.type);
            const decorators = isStruct ? '' : `@location(${input.location !== undefined ? input.location : locationIdx++}) `;
            stageArgs.push(`${decorators}${input.id} : ${this.resolveType(input.type)}`);
          }
        }
        let retType = 'vec4<f32>';
        let retDecorators = '@location(0)';
        if (func.outputs.length > 0) {
          const out = func.outputs[0];
          retType = this.resolveType(out.type);
          if ((ir.structs ?? []).some(s => s.id === out.type)) {
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
        if (this.allUsedBuiltins.has('global_invocation_id')) lines.push(`  GlobalInvocationID = gid;`);
        if (this.allUsedBuiltins.has('local_invocation_id')) lines.push(`  LocalInvocationID = lid;`);
        if (this.allUsedBuiltins.has('workgroup_id')) lines.push(`  WorkgroupID = wid;`);
        if (this.allUsedBuiltins.has('local_invocation_index')) lines.push(`  LocalInvocationIndex = lidx;`);
        if (this.allUsedBuiltins.has('num_workgroups')) lines.push(`  NumWorkgroups = nw;`);
        if (this.allUsedBuiltins.has('normalized_global_invocation_id')) {
          const wg = options.workgroupSize || [16, 16, 1];
          lines.push(`  NormalizedGlobalInvocationID = vec3<f32>(gid) / vec3<f32>(nw * vec3<u32>(${wg[0]}u, ${wg[1]}u, ${wg[2]}u));`);
        }

        this.emitPlaceholders(lines, options, nonBuiltinInputs.length > 0, emittedFunctions);

        for (const input of func.inputs) {
          if (input.builtin === 'global_invocation_id') lines.push(`  let l_${input.id} = gid;`);
          if (input.builtin === 'local_invocation_id') lines.push(`  let l_${input.id} = lid;`);
          if (input.builtin === 'workgroup_id') lines.push(`  let l_${input.id} = wid;`);
          if (input.builtin === 'local_invocation_index') lines.push(`  let l_${input.id} = lidx;`);
          if (input.builtin === 'num_workgroups') lines.push(`  let l_${input.id} = nw;`);
        }

        // Automatic Bounds Check - u_dispatch_size is present if inputBinding set
        if (options.inputBinding !== undefined) {
          lines.push(`  if (any(gid >= b_inputs.u_dispatch_size)) { return; }`);
        }
      }
    } else {
      const args = func.inputs.map(arg => `${arg.id}: ${this.resolveType(arg.type)}`).join(', ');
      let retType = 'void';
      if (func.outputs.length === 1) retType = this.resolveType(func.outputs[0].type);
      lines.push(`fn ${func.id}(${args})${retType === 'void' ? '' : ' -> ' + retType} {`);
    }

    const edges = reconstructEdges(func, options.fullIr);
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
    const entryNodes = func.nodes.filter(n => !edges.some(e => e.to === n.id && e.type === 'execution') && this.isExecutable(n.op, edges, n.id));
    for (const entry of entryNodes) this.emitChain(entry, func, lines, options, visited, ir, edges);
  }

  private isExecutable(op: string, edges: Edge[], nodeId: string) {
    const isSideEffecting = op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' || op === 'buffer_store' || op === 'texture_store' || op === 'call_func' || op === 'func_return' || op === 'array_set' || op === 'vec_set_element';

    if (isSideEffecting) return true;

    // A node is also considered "executable" if it has an outgoing execution edge,
    // meaning the user explicitly wants it to be part of the control flow.
    return edges.some(e => e.from === nodeId && e.type === 'execution');
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
      const valExpr = this.resolveArg(node, 'val', func, options, ir, 'any', edges);
      if (options.varMap?.has(varId)) {
        const idx = options.varMap.get(varId)!;
        const type = options.varTypes?.get(varId) || 'float';
        const isMatrix = type.includes('x');
        const count = this.getComponentCount(type);

        if (count === 1) {
          lines.push(`  b_globals.data[${idx}] = f32(${valExpr});`);
        } else if (isMatrix) {
          const dims = (count === 9) ? 3 : 4;
          for (let c = 0; c < dims; c++) {
            for (let r = 0; r < dims; r++) {
              lines.push(`  b_globals.data[${idx + c * dims + r}] = f32(${valExpr}[${c}][${r}]);`);
            }
          }
        } else {
          for (let i = 0; i < count; i++) {
            lines.push(`  b_globals.data[${idx + i}] = f32(${valExpr}[${i}]);`);
          }
        }
      } else if (func.localVars.some(v => v.id === varId)) {
        const localVar = func.localVars.find(v => v.id === varId)!;
        const targetType = localVar.type || 'float';
        const valType = options.nodeTypes?.get(node['val']) || 'float';
        const castExpr = this.wrapCast(valExpr, valType, targetType);
        lines.push(`  l_${varId} = ${castExpr};`);
      }
    } else if (node.op === 'array_set' || node.op === 'vec_set_element') {
      const targetId = (node['array'] || node['vec']) as string;
      let elemType = 'any';
      if (targetId) {
        // Resolve var_get to actual variable ID
        let varId = targetId;
        const sourceNode = func.nodes.find(n => n.id === targetId);
        if (sourceNode && sourceNode.op === 'var_get') {
          varId = sourceNode['var'] as string;
        }

        const v = func.localVars.find(l => l.id === varId);
        const i = func.inputs.find(inp => inp.id === varId);
        const t = (v?.type || i?.type || '').toLowerCase();
        if (t === 'int') elemType = 'int';
        else if (t === 'bool') elemType = 'bool';
        else if (t === 'float') elemType = 'float';
      }

      const idx = this.resolveArg(node, 'index', func, options, ir, 'int', edges);
      const val = this.resolveArg(node, 'value', func, options, ir, elemType, edges);

      let varId = targetId;
      const sourceNode = func.nodes.find(n => n.id === targetId);
      if (sourceNode && sourceNode.op === 'var_get') {
        varId = sourceNode['var'] as string;
      }

      if (options.varMap?.has(varId)) {
        const baseIdx = options.varMap.get(varId)!;
        lines.push(`${indent}b_globals.data[u32(${baseIdx}) + u32(${idx})] = f32(${val});`);
      } else {
        const arr = this.resolveArg(node, node.op === 'array_set' ? 'array' : 'vec', func, options, ir, 'any', edges);
        lines.push(`${indent}${arr}[u32(${idx})] = ${val};`);
      }
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
        const args = targetFunc.inputs.map(inp => this.resolveArg(node, `args.${inp.id}`, func, options, ir, 'any', edges)).join(', ');
        if (targetFunc.outputs.length > 0) lines.push(`${indent}let v_${node.id} = ${node['func']}(${args});`);
        else lines.push(`${indent}${node['func']}(${args});`);
      }
    } else if (node.op === 'func_return') {
      const isEntry = options.entryPointId === func.id;
      const isComputeEntry = isEntry && options.stage === 'compute';
      if (isComputeEntry) {
        lines.push(`${indent}return;`);
      } else {
        const prop = node['value'] !== undefined ? 'value' : 'val';
        lines.push(`${indent}return ${this.resolveArg(node, prop, func, options, ir, 'any', edges)};`);
      }
    } else if (node.op === 'flow_branch') {
      const cond = this.resolveArg(node, 'cond', func, options, ir, 'bool', edges);
      const isBoolExpr =
        cond === 'true' || cond === 'false' ||
        cond.includes('==') || cond.includes('!=') ||
        cond.includes('<') || cond.includes('>') ||
        cond.includes('&&') || cond.includes('||');

      const condExpr = isBoolExpr ? cond : `${cond} != 0.0`;
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
      const loopVar = `i_${node.id}`;
      if (node['count'] !== undefined) {
        const count = this.resolveArg(node, 'count', func, options, ir, 'int', edges);
        lines.push(`${indent}for (var ${loopVar} = 0; ${loopVar} < ${count}; ${loopVar}++) {`);
      } else {
        const start = this.resolveArg(node, 'start', func, options, ir, 'int', edges);
        const end = this.resolveArg(node, 'end', func, options, ir, 'int', edges);
        lines.push(`${indent}for (var ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);
      }
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
      lines.push(`${indent}if (u32(${idx}) < arrayLength(&${bufVar}.data)) {`);
      lines.push(`${indent}  ${bufVar}.data[u32(${idx})] = ${type}(${val});`);
      lines.push(`${indent}}`);
    } else if (node.op === 'cmd_dispatch') {
      const targetId = node['func'] as string;
      const targetFunc = ir.functions.find(f => f.id === targetId);
      if (targetFunc) {
        const dispatchArgs = targetFunc.inputs.map((inp: any) => this.resolveArg(node, `args.${inp.id}`, func, options, ir, 'any', edges)).join(', ');
        const dimExpr = this.resolveArg(node, 'dispatch', func, options, ir, 'any', edges);
        lines.push(`${indent}// Dispatch: ${targetId}(${dispatchArgs}) with dim ${dimExpr}`);
        // Dispatch is a command, usually not emitted directly as code in the shader body
        // but here we might be emitting a call if it's a nested dispatch (rare)
        // or just a placeholder.
        lines.push(`${indent}${targetId}(${dispatchArgs});`);
      }
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
    if (options.varMap?.has(varId)) {
      const idx = options.varMap.get(varId)!;
      const type = options.varTypes?.get(varId) || 'float';
      const count = this.getComponentCount(type);
      if (type === 'bool') return `bool(b_globals.data[${idx}])`;
      if (type === 'int') return `bitcast<i32>(u32(b_globals.data[${idx}]))`; // Use bitcast for safe re-interpretation of wrapped values if needed, or just i32() cast if we stored floats.
      // Actually, if we stored large int as float, i32() might be UB if out of range.
      // But we wrote f32(val). If val > 2^31, f32 has precision issues but holds magnitude.
      // JS numbers are f64. f32 can hold int32 exactly.
      // But test 2^31 is boundary.
      // Let's stick to simple cast first, if test fails we upgrade.
      if (type === 'int') return `i32(b_globals.data[${idx}])`;

      if (count === 1) return `b_globals.data[${idx}]`;
      if (type === 'float2' || type === 'vec2<f32>') return `vec2<f32>(b_globals.data[${idx}], b_globals.data[${idx + 1}])`;
      if (type === 'float3' || type === 'vec3<f32>') return `vec3<f32>(b_globals.data[${idx}], b_globals.data[${idx + 1}], b_globals.data[${idx + 2}])`;
      if (type === 'float4' || type === 'vec4<f32>') return `vec4<f32>(b_globals.data[${idx}], b_globals.data[${idx + 1}], b_globals.data[${idx + 2}], b_globals.data[${idx + 3}])`;
      if (type === 'int2' || type === 'vec2<i32>') return `vec2<i32>(i32(b_globals.data[${idx}]), i32(b_globals.data[${idx + 1}]))`;
      if (type === 'int3' || type === 'vec3<i32>') return `vec3<i32>(i32(b_globals.data[${idx}]), i32(b_globals.data[${idx + 1}]), i32(b_globals.data[${idx + 2}]))`;
      if (type === 'int4' || type === 'vec4<i32>') return `vec4<i32>(i32(b_globals.data[${idx}]), i32(b_globals.data[${idx + 1}]), i32(b_globals.data[${idx + 2}]), i32(b_globals.data[${idx + 3}]))`;
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
      if (type.startsWith('array<')) {
        const match = type.match(/,\s*(\d+)>/);
        if (match) {
          const len = parseInt(match[1]);
          const comps = [];
          for (let i = 0; i < len; i++) comps.push(`b_globals.data[${idx + i}]`);
          // We assume f32 elements in b_globals
          return `array<f32, ${len}>(${comps.join(', ')})`;
        }
      }
      return `b_globals.data[${idx}]`;
    }
    if (func.localVars.some(v => v.id === varId)) return `l_${varId}`;
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

    // New logic: check global inputs from the IR document
    // We must check BOTH the function's own inputs AND the global inputs
    const globalInput = options.fullIr?.inputs?.find((i: any) => i.id === varId);
    if (globalInput && options.inputBinding !== undefined) {
      const expr = `b_inputs.${varId}`;
      if (globalInput.type === 'bool') return `bool(${expr})`;
      return expr;
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
        // Check for inline swizzle suffix on the original property value
        let edgeSwizzle = '';
        for (const k of keys) {
          const origVal = node[k];
          if (typeof origVal === 'string' && origVal.includes('.')) {
            edgeSwizzle = origVal.substring(origVal.indexOf('.'));
            break;
          }
        }
        if (src.op === 'call_func') return `v_${src.id}` + edgeSwizzle;
        if (src.op === 'var_get') return this.getVariableExpr(src['var'], func, options) + edgeSwizzle;
        return this.compileExpression(src, func, options, ir, targetType, edges) + edgeSwizzle;
      }
    }

    for (const k of keys) {
      let val: any = undefined;

      // Path resolution for consolidated args (e.g., "args.foo" or "values[0]")
      if (k.includes('.') || k.includes('[')) {
        const parts = k.split(/[\.\[\]]/).filter(p => p !== '');
        let curr: any = node;
        for (const p of parts) {
          if (curr === undefined || curr === null) break;
          curr = curr[p];
        }
        val = curr;
      } else {
        val = node[k];
      }

      if (val !== undefined) {
        if (typeof val === 'string' && val.trim() !== '') {
          const tid = val.trim();
          // Inline swizzle support: "nodeId.xyz"
          let baseTid = tid;
          let swizzleSuffix = '';
          const dotIdx = tid.indexOf('.');
          if (dotIdx !== -1) {
            baseTid = tid.substring(0, dotIdx);
            swizzleSuffix = tid.substring(dotIdx); // includes the '.'
          }
          if (func.localVars.some(v => v.id === baseTid) ||
            func.inputs.some(i => i.id === baseTid) ||
            options.fullIr?.inputs?.some(i => i.id === baseTid) ||
            options.varMap?.has(baseTid)) {
            return this.getVariableExpr(baseTid, func, options) + swizzleSuffix;
          }
          const targetNode = func.nodes.find(n => n.id === baseTid);
          if (targetNode && targetNode.id !== node.id) return this.compileExpression(targetNode, func, options, ir, targetType, edges) + swizzleSuffix;
        }
        return this.formatLiteral(val, targetType || 'unknown');
      }
    }
    return this.formatZero(targetType || 'float');
  }

  private compileExpression(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument, targetType: string | DataType = 'float', edges: Edge[]): string {
    if (node.op === 'literal') return this.formatLiteral(node['val'], node['type'] || targetType || 'float');
    if (node.op === 'loop_index') return `i_${node['loop']}`;
    if (node.op === 'float') return this.resolveArg(node, 'val', func, options, ir, 'float', edges);
    if (node.op === 'int') return this.resolveArg(node, 'val', func, options, ir, 'int', edges);
    if (node.op === 'bool') return this.resolveArg(node, 'val', func, options, ir, 'bool', edges);
    if (['float2', 'float3', 'float4', 'int2', 'int3', 'int4'].includes(node.op)) {
      const isInt = node.op.startsWith('int');
      const dim = parseInt(node.op.replace(/^(float|int)/, ''));
      const wgslType = isInt ? `vec${dim}<i32>` : `vec${dim}<f32>`;
      const castFn = isInt ? 'i32' : 'f32';
      const scalarType = isInt ? 'int' : 'float';
      const compOrder = ['x', 'y', 'z', 'w'].slice(0, dim);

      // Detect component groups
      const groups = this.detectComponentGroups(node, dim);
      if (groups) {
        const argExprs = groups.map(g => {
          const expr = this.resolveArg(node, g.key, func, options, ir, g.count === 1 ? scalarType : `${scalarType}${g.count}`, edges);
          if (g.count === 1) return expr;
          // Wrap multi-component groups in vector constructor for broadcast/identity
          const vecCast = isInt ? `vec${g.count}<i32>` : `vec${g.count}<f32>`;
          return `${vecCast}(${expr})`;
        });
        return `${wgslType}(${argExprs.join(', ')})`;
      }

      // Default scalar-per-component
      const args = compOrder.map(c => `${castFn}(${this.resolveArg(node, c, func, options, ir, scalarType, edges)})`);
      return `${wgslType}(${args.join(', ')})`;
    }
    if (node.op === 'float3x3' || node.op === 'float4x4') {
      const vals = node['vals'];
      if (Array.isArray(vals)) {
        const formatted = vals.map(v => this.formatLiteral(v, 'float'));
        return `${node.op === 'float3x3' ? 'mat3x3<f32>' : 'mat4x4<f32>'}(${formatted.join(', ')})`;
      } else if (typeof vals === 'string') {
        const val = this.resolveArg(node, 'vals', func, options, ir, node.op === 'float3x3' ? 'float3x3' : 'float4x4', edges);

        // Detect if source is integer array to use helper
        if (node.op === 'float4x4') {
          const srcType = options.nodeTypes?.get(vals);
          if (srcType?.includes('int') || srcType?.includes('i32')) {
            return `mat4_from_array_i32(${val})`;
          }
        }

        // Default unpack (safe for f32 arrays or non-detectable types)
        const count = node.op === 'float3x3' ? 9 : 16;
        const args = [];
        for (let i = 0; i < count; i++) args.push(`f32(${val}[${i}])`);
        return `${node.op === 'float3x3' ? 'mat3x3<f32>' : 'mat4x4<f32>'}(${args.join(', ')})`;
      }
    }
    if (node.op === 'mat_identity') {
      const size = node['size'] || 4;
      if (size === 3) return 'mat3x3<f32>(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)';
      return 'mat4x4<f32>(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)';
    }
    if (node.op === 'mat_inverse') {
      const val = this.resolveArg(node, 'val', func, options, ir, 'any', edges);
      const type = options.nodeTypes?.get(node['val']) || 'float4x4';
      if (type === 'float3x3' || type === 'mat3x3<f32>') return `mat3_inverse(${val})`;
      return `mat4_inverse(${val})`;
    }
    if (node.op === 'mat_transpose') {
      const val = this.resolveArg(node, 'val', func, options, ir, 'any', edges);
      return `transpose(${val})`;
    }
    if (node.op === 'static_cast_float') return `f32(${this.resolveArg(node, 'val', func, options, ir, 'float', edges)})`;
    if (node.op === 'static_cast_int') {
      const valExpr = this.resolveArg(node, 'val', func, options, ir, 'any', edges);
      const valId = node['val'];
      const valType = typeof valId === 'string' ? (options.nodeTypes?.get(valId) || 'float') : 'float';
      if (valType === 'bool' || valType === 'boolean') return `i32(${valExpr})`;
      return `safe_f32_to_i32(${valExpr})`;
    }
    if (node.op === 'static_cast_bool') return `bool(${this.resolveArg(node, 'val', func, options, ir, 'any', edges)})`;
    if (node.op === 'static_cast_int2') return `vec2<i32>(${this.resolveArg(node, 'val', func, options, ir, 'any', edges)})`;
    if (node.op === 'static_cast_int3') return `vec3<i32>(${this.resolveArg(node, 'val', func, options, ir, 'any', edges)})`;
    if (node.op === 'static_cast_int4') return `vec4<i32>(${this.resolveArg(node, 'val', func, options, ir, 'any', edges)})`;
    if (node.op === 'static_cast_float2') return `vec2<f32>(${this.resolveArg(node, 'val', func, options, ir, 'any', edges)})`;
    if (node.op === 'static_cast_float3') return `vec3<f32>(${this.resolveArg(node, 'val', func, options, ir, 'any', edges)})`;
    if (node.op === 'static_cast_float4') return `vec4<f32>(${this.resolveArg(node, 'val', func, options, ir, 'any', edges)})`;
    if (node.op === 'struct_construct') {
      const type = node['type'];
      const structDef = ir.structs?.find(s => s.id === type);
      const args = structDef ? structDef.members.map(m => this.resolveArg(node, `values.${m.name}`, func, options, ir, 'any', edges)) : [];
      return `${type}(${args.join(', ')})`;
    }
    if (node.op === 'array_construct') {
      const values = node['values'];
      if (Array.isArray(values)) {
        const items = values.map((_, i) => this.resolveArg(node, `values[${i}]`, func, options, ir, 'any', edges));
        if (items.length === 0) return 'array<f32, 0>()';
        // Try to infer type from first resolved item or default to f32
        const type = node['type'] || options.varTypes?.get(values[0]) || 'f32';
        return `array<${this.resolveType(type)}, ${items.length}>(${items.join(', ')})`;
      }
      const len = node['length'] || 0;

      let type = 'f32';
      const rawFill = node['fill'];
      const inferredType = options.nodeTypes?.get(node.id);
      if (inferredType && (inferredType.startsWith('array<') || inferredType.includes('['))) {
        const match = inferredType.match(/array<([^,]+),/) || inferredType.match(/^([^\[]+)\[/);
        if (match) type = match[1];
      } else if (node['type']) {
        type = node['type'];
      } else if (typeof rawFill === 'number' && Number.isInteger(rawFill)) {
        type = 'i32';
      } else if (rawFill === true || rawFill === false) {
        type = 'bool';
      }

      // Special case: if fill is 0.0 but type is int, we MUST use int literal
      if (type === 'i32' || type === 'int') {
        // Resolve as int regardless of literal format in IR
        const fillExpr = this.resolveArg(node, 'fill', func, options, ir, 'int', edges);
        const vals = new Array(len).fill(null).map(() => fillExpr);
        return `array<i32, ${len}>(${vals.join(', ')})`;
      }

      const fillExpr = this.resolveArg(node, 'fill', func, options, ir, type === 'bool' ? 'bool' : 'float', edges);
      const vals = new Array(len).fill(null).map(() => fillExpr);

      return `array<${this.resolveType(type)}, ${len}>(${vals.join(', ')})`;
    }
    if (node.op === 'array_length') {
      const arr = this.resolveArg(node, 'array', func, options, ir, 'any', edges);
      return `i32(arrayLength(&${arr}))`;
    }
    if (node.op === 'texture_sample') {
      const tex = node['tex'];
      const coords = this.resolveArg(node, 'coords', func, options, ir, 'any', edges);
      return `sample_${tex}(${coords})`;
    }
    if (node.op === 'texture_load') {
      const tex = node['tex'];
      const coords = this.resolveArg(node, 'coords', func, options, ir, 'any', edges);
      const isStorage = options.storageResources?.has(tex);
      return `textureLoad(${tex}, vec2<i32>(${coords})${isStorage ? "" : ", 0u"})`;
    }

    // --- Quaternions ---
    if (node.op === 'quat') {
      // Check if constructing from components (x,y,z,w) or axis-angle
      const x = node['x'];
      if (x !== undefined) {
        // Components
        return `vec4<f32>(f32(${this.resolveArg(node, 'x', func, options, ir, 'float', edges)}), f32(${this.resolveArg(node, 'y', func, options, ir, 'float', edges)}), f32(${this.resolveArg(node, 'z', func, options, ir, 'float', edges)}), f32(${this.resolveArg(node, 'w', func, options, ir, 'float', edges)}))`;
      } else {
        const axis = this.resolveArg(node, 'axis', func, options, ir, 'float3', edges);
        const angle = this.resolveArg(node, 'angle', func, options, ir, 'float', edges);
        return `quat_from_axis_angle(${axis}, ${angle})`;
      }
    }
    if (node.op === 'quat_identity') {
      return `vec4<f32>(0.0, 0.0, 0.0, 1.0)`;
    }
    if (node.op === 'quat_mul') {
      const a = this.resolveArg(node, 'a', func, options, ir, 'float4', edges);
      const b = this.resolveArg(node, 'b', func, options, ir, 'float4', edges);
      return `quat_mul(${a}, ${b})`;
    }
    if (node.op === 'quat_slerp') {
      const a = this.resolveArg(node, 'a', func, options, ir, 'float4', edges);
      const b = this.resolveArg(node, 'b', func, options, ir, 'float4', edges);
      const t = this.resolveArg(node, 't', func, options, ir, 'float', edges);
      return `quat_slerp(${a}, ${b}, ${t})`;
    }
    if (node.op === 'quat_rotate') {
      const v = this.resolveArg(node, 'v', func, options, ir, 'float3', edges);
      const q = this.resolveArg(node, 'q', func, options, ir, 'float4', edges);
      return `quat_rotate(${v}, ${q})`;
    }
    if (node.op === 'quat_to_float4x4') {
      const q = this.resolveArg(node, 'q', func, options, ir, 'float4', edges);
      return `quat_to_mat4(${q})`;
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
      return `color_mix_impl(${this.resolveArg(node, 'a', func, options, ir, 'float4', edges)}, ${this.resolveArg(node, 'b', func, options, ir, 'float4', edges)})`;
    }
    if (node.op === 'vec_swizzle') {
      const vec = this.resolveArg(node, 'vec', func, options, ir, 'any', edges);
      const swizzle = node['channels'];
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


        // Also check nodeTypes and varTypes for intermediate nodes or global inputs
        const getV = (m: Map<string, string> | undefined, id: string) => {
          const v = m?.get(id);
          return (v && v !== 'any') ? v : null;
        };
        const rawType = getV(options.nodeTypes as any, targetId) ||
          getV(options.varTypes as any, targetId) ||
          targetIn?.type ||
          targetVar?.type ||
          options.fullIr?.inputs?.find(i => i.id === targetId)?.type ||
          '';
        let t = rawType.toLowerCase();

        // Fallback: Check target node op if type is unknown or 'any' (default map val)
        if (!t || t === 'any') {
          const targetNode = func.nodes.find(n => n.id === targetId);
          if (targetNode) {
            const op = targetNode.op;
            if (op === 'float3x3' || (op === 'mat_identity' && targetNode['size'] === 3)) t = 'mat3x3<f32>';
            else if (op === 'float4x4' || op === 'mat_inverse' || op === 'mat_transpose' || op === 'mat_identity' || op === 'quat_to_mat4') t = 'mat4x4<f32>';
          }
        }

        if (t === 'float3x3' || t === 'mat3x3<f32>') {
          return `(${vec})[u32(${idx} / 3)][u32(${idx} % 3)]`;
        } else if (t === 'float4x4' || t === 'mat4x4<f32>') {
          return `(${vec})[u32(${idx} / 4)][u32(${idx} % 4)]`;
        }
      }

      return `(${vec})[u32(${idx})]`;
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
      const outType = options.nodeTypes?.get(node.id) || 'float3';
      let expr = 'gid';
      if (name === 'global_invocation_id') expr = 'GlobalInvocationID';
      else if (name === 'local_invocation_id') expr = 'LocalInvocationID';
      else if (name === 'workgroup_id') expr = 'WorkgroupID';
      else if (name === 'local_invocation_index') expr = 'LocalInvocationIndex';
      else if (name === 'num_workgroups') expr = 'NumWorkgroups';
      else if (name === 'normalized_global_invocation_id') expr = 'NormalizedGlobalInvocationID';
      else if (name === 'frag_coord') expr = 'FragCoord';
      else if (name === 'front_facing') expr = 'FrontFacing';
      else if (name === 'position') expr = 'Position';
      else if (name === 'vertex_index') expr = 'VertexIndex';
      else if (name === 'instance_index') expr = 'InstanceIndex';
      else if (['time', 'delta_time', 'bpm', 'beat_number', 'beat_delta'].includes(name)) expr = `b_inputs.${name}`;

      // Built-ins in WGSL are often u32 or vecN<u32>.
      // Our IR often expects floats for generic math, or ints for integer math.
      if (outType.startsWith('float') || outType === 'float') {
        const count = this.getComponentCount(outType);
        if (count === 1) return `f32(${expr})`;
        return `vec${count}<f32>(${expr})`;
      }
      if (outType.startsWith('int') || outType === 'int') {
        const count = this.getComponentCount(outType);
        if (count === 1) return `i32(${expr})`;
        return `vec${count}<i32>(${expr})`;
      }
      return expr;
    }
    if (this.isMathOp(node.op)) return this.compileMath(node, func, options, ir, edges, targetType);
    return '0.0';
  }

  private isMathOp(op: string) { return op.startsWith('math_') || op.startsWith('vec_') || op.startsWith('quat_') || op.startsWith('mat_'); }

  private compileMath(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument, edges: Edge[], targetType: string | DataType = 'float'): string {
    const op = node.op;
    const outType = options.nodeTypes?.get(node.id) || 'float';
    // If target type implies boolean, force bool result (disable float casting)
    const forceBool = targetType === 'bool' || targetType === 'boolean';
    const isFloatResult = !forceBool && (outType.startsWith('float') || outType === 'float' || outType.includes('x'));
    const isBoolResult = forceBool || outType === 'boolean' || outType === 'bool';

    // Helper to resolve argument type
    const getType = (k: string) => {
      const val = node[k];
      let t = (typeof val === 'string' ? options.nodeTypes?.get(val) : null) || 'float';

      // Normalize IR types to WGSL types
      if (t === 'float2') t = 'vec2<f32>';
      if (t === 'float3') t = 'vec3<f32>';
      if (t === 'float4') t = 'vec4<f32>';
      if (t === 'int2') t = 'vec2<i32>';
      if (t === 'int3') t = 'vec3<i32>';
      if (t === 'int4') t = 'vec4<i32>';

      if (t === 'float' && typeof val === 'string') {
        const def = func.nodes.find(n => n.id === val);
        if (def) {
          if (def.op === 'float2') t = 'vec2<f32>';
          else if (def.op === 'float3') t = 'vec3<f32>';
          else if (def.op === 'float4') t = 'vec4<f32>';
          else if (def.op === 'int2') t = 'vec2<i32>';
          else if (def.op === 'int3') t = 'vec3<i32>';
          else if (def.op === 'int4') t = 'vec4<i32>';
        }
      }

      if (Array.isArray(val)) return `float${val.length}`;
      return t;
    };

    // Helper for comparisons/logic that might need float casting
    const cmp = (expr: string) => {
      if (isFloatResult) {
        const count = this.getComponentCount(outType);
        const type = count > 1 ? `vec${count}<f32>` : 'f32';
        const zero = count > 1 ? `vec${count}<f32>(0.0)` : '0.0';
        const one = count > 1 ? `vec${count}<f32>(1.0)` : '1.0';
        return `select(${zero}, ${one}, ${expr})`;
      }
      return expr;
    };

    // Helper to resolve argument generic expression
    const arg = (k: string) => {
      const expr = this.resolveArg(node, k, func, options, ir, 'any', edges);
      const argType = getType(k);
      if (isFloatResult && argType === 'int') return `f32(${expr})`;
      if (isFloatResult && (argType === 'vec2<i32>' || argType === 'int2')) return `vec2<f32>(${expr})`;
      if (isFloatResult && (argType === 'vec3<i32>' || argType === 'int3')) return `vec3<f32>(${expr})`;
      if (isFloatResult && (argType === 'vec4<i32>' || argType === 'int4')) return `vec4<f32>(${expr})`;
      if (!isFloatResult && !isBoolResult && argType === 'float') return `i32(${expr})`;
      return expr;
    };

    if (op === 'math_mix' || op === 'vec_mix') {
      return `mix(${arg('a')}, ${arg('b')}, ${arg('t')})`;
    }

    // Helper to broadcast scalar to vector if needed
    const broadcast = (k: string, targetType: string) => {
      const expr = arg(k);
      const argType = getType(k);
      const argCount = this.getComponentCount(argType);
      const targetCount = this.getComponentCount(targetType);

      if (argCount === 1 && targetCount > 1) {
        return `vec${targetCount}<f32>(${expr})`;
      }
      return expr;
    };

    // Constants
    if (op === 'math_pi') return '3.14159265';
    if (op === 'math_e') return '2.71828183';

    // Core Arithmetic with Broadcasting
    // Core Arithmetic with Broadcasting
    if (op === 'math_add' || op === 'math_sub' || op === 'math_div' || op === 'math_mod' || op === 'math_atan2') {
      const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, options, ir, edges);

      if (op === 'math_add') return `(${aExpr} + ${bExpr})`;
      if (op === 'math_sub') return `(${aExpr} - ${bExpr})`;
      if (op === 'math_div') {
        const bVal = node['b'];
        // Detect literal div by zero
        if (typeof bVal === 'number' && bVal === 0.0) return 'get_inf()';
        return `(${aExpr} / ${bExpr})`;
      }
      if (op === 'math_mod') return `(${aExpr} % ${bExpr})`;
      if (op === 'math_atan2') return `atan2(${aExpr}, ${bExpr})`;
    }

    if (op === 'math_mul' || op === 'mat_mul') {
      const [aExpr, bExpr] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, options, ir, edges);
      return `(${aExpr} * ${bExpr})`;
    }
    if (op === 'math_neg') return `(-${arg('val')})`;

    // Standard Math
    if (op === 'math_abs') return `abs(${arg('val')})`;
    if (op === 'math_sin') return `sin(${arg('val')})`;
    if (op === 'math_cos') return `cos(${arg('val')})`;
    if (op === 'math_tan') return `tan(${arg('val')})`;
    if (op === 'math_asin') return `asin(${arg('val')})`;
    if (op === 'math_acos') return `acos(${arg('val')})`;
    if (op === 'math_atan') return `atan(${arg('val')})`;
    if (op === 'math_asinh') return `asinh(${arg('val')})`;
    if (op === 'math_acosh') return `acosh(${arg('val')})`;
    if (op === 'math_atanh') return `atanh(${arg('val')})`;
    if (op === 'math_sinh') return `sinh(${arg('val')})`;
    if (op === 'math_cosh') return `cosh(${arg('val')})`;
    if (op === 'math_tanh') return `tanh(${arg('val')})`;

    if (node.op === 'math_sqrt') {
      const val = node['val'];
      if (typeof val === 'number' && val < 0) return 'get_nan()'; // Emit NaN (Quiet NaN)
      return `sqrt(${arg('val')})`;
    }
    if (op === 'math_exp') return `exp(${arg('val')})`;
    if (op === 'math_log') {
      const val = node['val'];
      if (typeof val === 'number' && val <= 0) return 'get_neginf()'; // Emit -Infinity
      return `log(${arg('val')})`;
    }
    if (op === 'math_pow') return `pow(${arg('a')}, ${arg('b')})`;

    if (op === 'math_trunc') return `trunc(${arg('val')})`;
    if (op === 'math_round') return `round(${arg('val')})`;
    if (op === 'math_floor') return `floor(${arg('val')})`;
    if (op === 'math_ceil') return `ceil(${arg('val')})`;
    if (op === 'math_fract') return `fract(${arg('val')})`;
    if (op === 'math_sign') return `sign(${arg('val')})`;

    if (op === 'math_min') return `min(${arg('a')}, ${arg('b')})`;
    if (op === 'math_max') return `max(${arg('a')}, ${arg('b')})`;

    // MAD with broadcasting
    if (op === 'math_mad') {
      // fma(a, b, c) -> a * b + c
      // WGSL fma supports (vec, vec, vec) or (scalar, scalar, scalar)
      // Mixed broadcasting needs handling
      const typeA = getType('a');
      const typeB = getType('b');
      const typeC = getType('c');
      const count = Math.max(this.getComponentCount(typeA), this.getComponentCount(typeB), this.getComponentCount(typeC));
      const targetType = count > 1 ? `vec${count}<f32>` : 'float';

      return `fma(${broadcast('a', targetType)}, ${broadcast('b', targetType)}, ${broadcast('c', targetType)})`;
    }

    if (op === 'math_clamp') {
      const typeVal = getType('val');
      const typeMin = getType('min');
      const typeMax = getType('max');
      // clamp(e1, e2, e3). e2 and e3 must handle broadcasting if e1 is vector
      return `clamp(${arg('val')}, ${broadcast('min', typeVal)}, ${broadcast('max', typeVal)})`;
    }

    if (op === 'math_mix' || op === 'vec_mix') {
      // mix(e1, e2, e3). e3 (t) can be scalar or matching vector
      return `mix(${arg('a')}, ${arg('b')}, ${arg('t')})`;
    }

    if (op === 'math_step') return `step(${arg('edge')}, ${arg('val')})`;
    if (op === 'math_smoothstep') return `smoothstep(${arg('edge0')}, ${arg('edge1')}, ${arg('val')})`;

    // Rounding
    if (op === 'math_fract') return `fract(${arg('val')})`;
    if (op === 'math_trunc') return `trunc(${arg('val')})`;

    // Advanced Math / Bits
    if (op === 'math_frexp_mantissa' || op === 'math_mantissa') return `get_mantissa(${arg('val')})`;
    if (op === 'math_frexp_exponent' || op === 'math_exponent') return `get_exponent(${arg('val')})`;
    if (op === 'math_ldexp') return `ldexp(f32(${this.resolveArg(node, 'fract', func, options, ir, 'float', edges)}), i32(${this.resolveArg(node, 'exp', func, options, ir, 'int', edges)}))`;
    if (op === 'math_flush_subnormal') {
      return `flush_subnormal(${arg('val')})`;
    }

    // Comparison & Logic
    if (op === 'math_is_nan') {
      let type = getType('val');
      const valExpr = arg('val');
      if (type === 'float' && (valExpr.startsWith('vec') || valExpr.startsWith('bitcast<vec'))) {
        if (valExpr.includes('vec2')) type = 'vec2<f32>';
        if (valExpr.includes('vec3')) type = 'vec3<f32>';
        if (valExpr.includes('vec4')) type = 'vec4<f32>';
      }

      if (type.startsWith('vec2')) return cmp(`is_nan_vec2(${valExpr})`);
      if (type.startsWith('vec3')) return cmp(`is_nan_vec3(${valExpr})`);
      if (type.startsWith('vec4')) return cmp(`is_nan_vec4(${valExpr})`);
      return cmp(`is_nan(${valExpr})`);
    }
    if (op === 'math_is_inf') {
      let type = getType('val');
      const valExpr = arg('val');
      if (type === 'float' && (valExpr.startsWith('vec') || valExpr.startsWith('bitcast<vec'))) {
        if (valExpr.includes('vec2')) type = 'vec2<f32>';
        if (valExpr.includes('vec3')) type = 'vec3<f32>';
        if (valExpr.includes('vec4')) type = 'vec4<f32>';
      }

      if (type.startsWith('vec2')) return cmp(`is_inf_vec2(${valExpr})`);
      if (type.startsWith('vec3')) return cmp(`is_inf_vec3(${valExpr})`);
      if (type.startsWith('vec4')) return cmp(`is_inf_vec4(${valExpr})`);
      return cmp(`is_inf(${valExpr})`);
    }
    if (op === 'math_is_finite') {
      let type = getType('val');
      const valExpr = arg('val');
      if (type === 'float' && (valExpr.startsWith('vec') || valExpr.startsWith('bitcast<vec'))) {
        if (valExpr.includes('vec2')) type = 'vec2<f32>';
        if (valExpr.includes('vec3')) type = 'vec3<f32>';
        if (valExpr.includes('vec4')) type = 'vec4<f32>';
      }

      if (type.startsWith('vec2')) return cmp(`is_finite_vec2(${valExpr})`);
      if (type.startsWith('vec3')) return cmp(`is_finite_vec3(${valExpr})`);
      if (type.startsWith('vec4')) return cmp(`is_finite_vec4(${valExpr})`);
      return cmp(`is_finite(${valExpr})`);
    }

    if (op === 'math_mix' || op === 'vec_mix') {
      const tType = getType('t');
      // If mixing condition is boolean (scalar or vector), use select(falseVal, trueVal, cond)
      // Note: mix(a, b, t) corresponds to select(a, b, t) logic if we treat false->a, true->b?
      // Wait, mix(x, y, a): x*(1-a) + y*a.
      // If a is 0 (false), result is x. If a is 1 (true), result is y.
      // select(f, t, cond): if cond is false -> f, true -> t.
      // So mix(a, b, cond) maps exactly to select(a, b, cond).
      if (tType === 'bool' || tType === 'boolean' || tType.includes('bool')) {
        return `select(${arg('a')}, ${arg('b')}, ${arg('t')})`;
      }
      return `mix(${arg('a')}, ${arg('b')}, ${arg('t')})`;
    }


    if (op === 'math_gt') return cmp(`(${arg('a')} > ${arg('b')})`);
    if (op === 'math_lt') return cmp(`(${arg('a')} < ${arg('b')})`);
    if (op === 'math_ge') return cmp(`(${arg('a')} >= ${arg('b')})`);
    if (op === 'math_le') return cmp(`(${arg('a')} <= ${arg('b')})`);
    if (op === 'math_eq') return cmp(`(${arg('a')} == ${arg('b')})`);
    if (op === 'math_neq') return cmp(`(${arg('a')} != ${arg('b')})`);

    if (op === 'math_and') return `(${arg('a')} && ${arg('b')})`;
    if (op === 'math_or') return `(${arg('a')} || ${arg('b')})`;
    if (op === 'math_xor') return `(${arg('a')} != ${arg('b')})`; // Boolean XOR is !=
    if (op === 'math_not') return `(!${arg('val')})`;

    // Vectors
    if (op === 'vec_dot') return `dot(${arg('a')}, ${arg('b')})`;
    if (op === 'vec_cross') return `cross(${arg('a')}, ${arg('b')})`;
    if (op === 'vec_length') return `length(${arg('a')})`;
    if (op === 'vec_normalize') return `normalize(${arg('a')})`;
    if (op === 'vec_distance') return `distance(${arg('a')}, ${arg('b')})`;
    if (op === 'vec_reflect') return `reflect(${arg('a')}, ${arg('b')})`;
    if (op === 'vec_refract') return `refract(${arg('a')}, ${arg('b')}, ${this.resolveArg(node, 'eta', func, options, ir, 'float', edges)})`;

    console.warn(`[WgslGen] compileMath UNHANDLED: ${op}`);
    return '0.0';
  }

  private resolveType(type: DataType | string): string {
    if (type === 'float') return 'f32';
    if (type === 'int') return 'i32';
    if (type === 'int2') return 'vec2<i32>';
    if (type === 'int3') return 'vec3<i32>';
    if (type === 'int4') return 'vec4<i32>';
    if (type === 'bool') return 'bool';
    if (type === 'float2') return 'vec2<f32>';
    if (type === 'float3') return 'vec3<f32>';
    if (type === 'float4') return 'vec4<f32>';
    if (type === 'float3x3') return 'mat3x3<f32>';
    if (type === 'float4x4') return 'mat4x4<f32>';
    if (type === 'string') throw new Error('Shaders do not support string type');
    if (type === 'texture2d') return 'texture_2d<f32>';
    if (type === 'sampler') return 'sampler';
    if (type === 'sampler_comparison') return 'sampler_comparison';

    // Handle array types: float[3] or array<float, 3> or float[]
    if (type.includes('[') || type.startsWith('array<')) {
      const match = type.match(/(\w+)\[(\d*)\]/);
      if (match) {
        const inner = match[1];
        const len = match[2];
        return len ? `array<${this.resolveType(inner)}, ${len}>` : `array<${this.resolveType(inner)} > `;
      }
      const match2 = type.match(/^array<(.+?)(?:,\s*(\d+))?>$/);
      if (match2) {
        const inner = match2[1];
        const len = match2[2];
        return len ? `array<${this.resolveType(inner)}, ${len}>` : `array<${this.resolveType(inner)}>`;
      }
      return type;
    }

    return type;
  }

  private getComponentCount(type: DataType | string): number {
    if (type === 'float2' || type === 'vec2<f32>' || type === 'int2' || type === 'vec2<i32>') return 2;
    if (type === 'float3' || type === 'vec3<f32>' || type === 'int3' || type === 'vec3<i32>') return 3;
    if (type === 'float4' || type === 'vec4<f32>' || type === 'quat' || type === 'int4' || type === 'vec4<i32>') return 4;
    if (type === 'float3x3' || type === 'mat3x3<f32>') return 9;
    if (type === 'float4x4' || type === 'mat4x4<f32>') return 16;

    // Handle array<T, N>
    if (type.startsWith('array<')) {
      const match = type.match(/,\s*(\d+)>/);
      if (match) return parseInt(match[1]);
    }

    return 1;
  }

  private resolveCoercedArgs(
    node: Node,
    keys: string[],
    mode: 'float' | 'unify',
    func: FunctionDef,
    options: WgslOptions,
    ir: IRDocument,
    edges: Edge[]
  ): string[] {
    // Resolve raw args first (using 'any' to get their natural representation)
    const rawArgs = keys.map(k => this.resolveArg(node, k, func, options, ir, 'any', edges));

    if (!options.nodeTypes) return rawArgs;

    // Determine types
    const getType = (k: string) => {
      // 1. Check for incoming edge
      const edge = edges.find(e => e.to === node.id && e.portIn === k);
      let val: any;

      if (edge) {
        val = edge.from; // The ID of the source node
      } else {
        val = node[k];
      }

      if (typeof val === 'number') return Number.isInteger(val) ? 'int' : 'float';
      if (typeof val === 'boolean') return 'bool';
      // Look up type from var or node
      let t: string | undefined;
      if (typeof val === 'string') {
        // Special case for 'varMap' overrides (ForceOntoGPU backend hack)
        // If a var_get refers to a var in varMap, it is promoted to global storage (float)
        if (options.varMap) {
          const n = func.nodes.find(n => n.id === val);
          if (n && n.op === 'var_get') {
            const vId = n['var'];
            if (options.varMap.has(vId)) {
              // We could check varTypes, but ForceOntoGPU usually promotes to float storage
              // If varTypes says float/floatN, return it. Default float.
              const vt = options.varTypes?.get(vId) || 'float';
              // Map vec2<f32> to float2 etc if needed, but 'float' is safe for scalar
              return vt;
            }
          }
        }

        t = options.nodeTypes?.get(val);
        // Fallback: check input types or var types if not in nodeTypes
        if (!t) {
          const v = func.inputs.find(i => i.id === val);
          if (v) t = v.type;
        }
        if (!t) {
          const v = func.localVars.find(v => v.id === val);
          if (v) t = v.type;
        }
        if (!t) {
          const gi = ir.inputs?.find(i => i.id === val);
          if (gi) t = gi.type;
        }
        // Fallback: Check node op if reachable
        if (!t) {
          const n = func.nodes.find(n => n.id === val);
          if (n) {
            if (n.op === 'loop_index') t = 'int';
            if (n.op === 'array_length') t = 'int';
            if (n.op === 'resource_get_format') t = 'int';
          }
        }
        // Fix: nodeTypes may say 'float' for binary math ops that actually emit i32
        // (because the validator treats integer literals as 'float').
        // Check if the referenced node is a binary math op with all-int operands.
        if (t === 'float') {
          const binaryMathOps = ['math_add', 'math_sub', 'math_mul', 'math_div', 'math_mod'];
          const refNode = func.nodes.find(n => n.id === val);
          if (refNode && binaryMathOps.includes(refNode.op)) {
            const getDirectArgType = (argKey: string): string => {
              const argEdge = edges.find(e => e.to === refNode.id && e.portIn === argKey);
              const argVal = argEdge ? argEdge.from : refNode[argKey];
              if (typeof argVal === 'number') return Number.isInteger(argVal) ? 'int' : 'float';
              if (typeof argVal === 'string') {
                const nt = options.nodeTypes?.get(argVal);
                if (nt) return nt;
                const fi = func.inputs.find(i => i.id === argVal);
                if (fi) return fi.type;
                const lv = func.localVars.find(v => v.id === argVal);
                if (lv) return lv.type;
                const gi = ir.inputs?.find(i => i.id === argVal);
                if (gi) return gi.type;
                const nn = func.nodes.find(n => n.id === argVal);
                if (nn && (nn.op === 'loop_index' || nn.op === 'array_length')) return 'int';
              }
              return 'float';
            };
            const aType = getDirectArgType('a');
            const bType = getDirectArgType('b');
            if ((aType === 'int' || aType === 'i32') && (bType === 'int' || bType === 'i32')) {
              t = 'int';
            }
          }
        }
      }
      return t || 'float';
    };

    const argTypes = keys.map(getType);

    // Apply unification/casting
    let result = rawArgs;
    if (mode === 'float') {
      result = rawArgs.map((arg, i) => {
        const t = argTypes[i];
        if (t === 'int' || t === 'i32' || t === 'bool') {
          return `f32(${arg})`;
        }
        if (t === 'int2' || t === 'vec2<i32>') return `vec2<f32>(${arg})`;
        if (t === 'int3' || t === 'vec3<i32>') return `vec3<f32>(${arg})`;
        if (t === 'int4' || t === 'vec4<i32>') return `vec4<f32>(${arg})`;
        return arg;
      });
    } else if (mode === 'unify') {
      const hasFloat = argTypes.some(t => t.includes('float') || t.includes('f32') || t.includes('mat'));
      if (hasFloat) {
        result = rawArgs.map((arg, i) => {
          const t = argTypes[i];
          if (t === 'int' || t === 'i32' || t === 'bool') {
            return `f32(${arg})`;
          }
          if (t === 'int2' || t === 'vec2<i32>') return `vec2<f32>(${arg})`;
          if (t === 'int3' || t === 'vec3<i32>') return `vec3<f32>(${arg})`;
          if (t === 'int4' || t === 'vec4<i32>') return `vec4<f32>(${arg})`;
          return arg;
        });
      }
    }

    return result;
  }

  /** Detect component-group keys on a vector constructor node. Returns sorted groups or null if standard x/y/z/w form. */
  private detectComponentGroups(node: Node, dim: number): { key: string, startIdx: number, count: number }[] | null {
    const compOrder = ['x', 'y', 'z', 'w'];
    const validGroups = ['x', 'y', 'z', 'w', 'xy', 'yz', 'zw', 'xyz', 'yzw', 'xyzw'];
    const groups: { key: string, startIdx: number, count: number }[] = [];

    for (const key of validGroups) {
      if (node[key] !== undefined && key.length > 1) {
        groups.push({ key, startIdx: compOrder.indexOf(key[0]), count: key.length });
      }
    }
    if (groups.length === 0) return null;

    // Also include any single-component keys that are present
    for (let i = 0; i < dim; i++) {
      const c = compOrder[i];
      if (node[c] !== undefined && !groups.some(g => g.startIdx <= i && i < g.startIdx + g.count)) {
        groups.push({ key: c, startIdx: i, count: 1 });
      }
    }

    groups.sort((a, b) => a.startIdx - b.startIdx);
    return groups;
  }

  private formatLiteral(val: any, type: string | DataType): string {
    if (typeof val === 'number') {
      // For integer types in WGSL, no decimal points allowed
      if (type === 'int' || type === 'i32') {
        return Math.floor(val).toString();
      }

      const s = val.toString();

      // If type is explicitly float, we must ensure it looks like a float
      if (type === 'float' || type === 'f32' || type.startsWith('vec') || type.startsWith('mat')) {
        if (s.toLowerCase().includes('e')) return s;
        return s.includes('.') ? s : s + '.0';
      }

      // If type is unknown/any, preserve apparent type (AbstractInt vs AbstractFloat)
      return s;
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
    return '0.0';
  }

  private formatZero(type: string | DataType): string {
    const t = this.resolveType(type);
    if (t === 'f32') return '0.0';
    if (t === 'i32') return '0';

    if (t === 'bool') return 'false';
    if (t === 'vec2<i32>') return 'vec2<i32>(0)';
    if (t === 'vec3<i32>') return 'vec3<i32>(0)';
    if (t === 'vec4<i32>') return 'vec4<i32>(0)';
    if (t.startsWith('vec')) return `${t}(0.0)`;
    if (t.startsWith('mat')) return `${t}()`;
    return `${t}()`;
  }

  public static findUsedResources(func: FunctionDef, ir: IRDocument | ResourceDef[]): Set<string> {
    const resources = new Set<string>();
    const allResources = Array.isArray(ir) ? ir : [...(ir.resources || []), ...ir.inputs];
    const resourceIds = new Set(allResources.map(r => r.id));

    func.nodes.forEach(node => {
      const opDef = OpDefs[node.op as BuiltinOp];
      if (!opDef) return;

      for (const [argName, argDef] of Object.entries(opDef.args)) {
        if (argDef.refType === 'resource') {
          // Check top-level or consolidated 'args'
          let resId = node[argName];
          if (resId === undefined && node['args']) {
            resId = node['args'][argName];
          }

          if (typeof resId === 'string' && resourceIds.has(resId)) {
            resources.add(resId);
          }
        }
      }
    });

    return resources;
  }

  private wrapCast(expr: string, fromType: DataType | string, toType: DataType | string): string {
    if (fromType === toType) return expr;
    if (fromType === 'any' || toType === 'any') return expr;

    const fromCount = this.getComponentCount(fromType);
    const toCount = this.getComponentCount(toType);

    if (toType === 'float') return `f32(${expr})`;
    if (toType === 'int') return `i32(${expr})`;

    if (toType === 'bool' || toType === 'boolean') return `bool(${expr})`;

    if (toType.startsWith('float') && toCount > 1 && !toType.includes('x')) {
      if (fromCount === 1) return `vec${toCount}<f32>(${expr})`;
      return `vec${toCount}<f32>(${expr})`;
    }

    if (toType === 'int2' || toType === 'vec2<i32>') return `vec2<i32>(${expr})`;
    if (toType === 'int3' || toType === 'vec3<i32>') return `vec3<i32>(${expr})`;
    if (toType === 'int4' || toType === 'vec4<i32>') return `vec4<i32>(${expr})`;

    return expr;
  }

  private validateRecursion(functions: FunctionDef[]) {
    const adj = new Map<string, string[]>();
    for (const f of functions) {
      const calls = f.nodes.filter(n => n.op === 'call_func').map(n => n['func'] as string);
      adj.set(f.id, calls);
    }

    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (id: string, path: string[]) => {
      visited.add(id);
      stack.add(id);
      path.push(id);

      const children = adj.get(id) || [];
      for (const child of children) {
        if (!visited.has(child)) {
          dfs(child, path);
        } else if (stack.has(child)) {
          throw new Error(`Recursion detected|cyclic dependency: ${path.join(' -> ')} -> ${child}`);
        }
      }

      stack.delete(id);
      path.pop();
    };

    for (const f of functions) {
      if (!visited.has(f.id)) {
        dfs(f.id, []);
      }
    }
  }

  static resolveImports(compilationResult: CompilationResult): string {
    let code = compilationResult.code;
    for (const [key, value] of Object.entries(compilationResult.imports)) {
      code = code.replace(key, value);
    }
    return code;
  }
}

