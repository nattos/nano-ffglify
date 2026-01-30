
import { FunctionDef, Node, Edge, DataType, ResourceDef, IRDocument } from '../../ir/types';

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
}

export class WgslGenerator {
  private helpers = new Set<string>();

  compile(ir: IRDocument, entryPointId: string, options: WgslOptions = {}): string {
    this.helpers.clear();
    const lines: string[] = []; // For structs, texture samplers, and non-entry functions
    const entryPointLines: string[] = []; // For the entry point function itself
    const entryFunc = ir.functions.find(f => f.id === entryPointId);
    if (!entryFunc) throw new Error(`Entry point function '${entryPointId}' not found`);

    // Generate Structs
    this.generateStructs(ir, lines);

    // Generate Texture Samplers
    this.emitTextureSamplers(lines, options);

    // Generate Helper Functions (All except Entry Point)
    const helperFuncs = ir.functions.filter(f => f.id !== entryPointId);
    for (const func of helperFuncs) {
      this.emitFunction(func, false, lines, options, ir);
      lines.push('');
    }

    // Generate Entry Point
    this.emitFunction(entryFunc, true, entryPointLines, options, ir);

    // Assemble final shader code
    const finalLines: string[] = [];
    finalLines.push('diagnostic(off, derivative_uniformity);');
    finalLines.push('');

    // Globals Buffer (for ComputeTestBackend)
    if (options.globalBufferBinding !== undefined) {
      finalLines.push('struct GlobalsBuffer { data: array<f32> }');
      finalLines.push(`@group(0) @binding(${options.globalBufferBinding}) var<storage, read_write> b_globals : GlobalsBuffer;`);
      finalLines.push('');
    }

    // Resource Bindings
    if (options.resourceBindings) {
      options.resourceBindings.forEach((bindingIdx, resId) => {
        const def = options.resourceDefs?.get(resId);
        // console.log('Gen Binding:', resId, def?.dataType, 'Types:', def?.type); // Debug line, keep for now
        if (def?.type === 'buffer' || !def) {
          // Default to buffer if unknown or explicit buffer
          const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
          const structName = `Buffer_${resId}`;
          finalLines.push(`struct ${structName} { data: array<${type}> }`);
          finalLines.push(`@group(0) @binding(${bindingIdx}) var<storage, read_write> b_${resId} : ${structName};`);
        } else if (def.type === 'texture2d') {
          // For now, assume sampled texture.
          // In future, check usage to decide storage vs sampled.
          // Using f32 as component type (standard for float textures)
          finalLines.push(`@group(0) @binding(${bindingIdx}) var ${resId} : texture_2d<f32>;`);
        }
      });
      if (options.resourceBindings.size > 0) finalLines.push('');
    }

    /*
    // Hardware Samplers (Currently disabled for Compute emulation, available in render stages)
    if (options.samplerBindings) {
      options.samplerBindings.forEach((bindingIdx, resId) => {
        finalLines.push(`@group(0) @binding(${bindingIdx}) var s_${resId} : sampler;`);
      });
      finalLines.push('');
    }
    */

    // Add injected helpers
    if (this.helpers.size > 0) {
      finalLines.push('// Injected Helpers');
      this.helpers.forEach(h => finalLines.push(h));
      finalLines.push('');
    }

    // Add generated structs, texture samplers, and non-entry functions
    finalLines.push(...lines);

    // Add entry point function
    finalLines.push(...entryPointLines);

    return finalLines.join('\n');
  }

  private addHelper(code: string) {
    this.helpers.add(code);
  }

  private emitTextureSamplers(lines: string[], options: WgslOptions) {
    if (!options.resourceDefs) return;
    options.resourceDefs.forEach((def, id) => {
      if (def.type === 'texture2d') {
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
    if (!ir.structs) return;
    for (const s of ir.structs) {
      lines.push(`struct ${s.id} {`);
      for (const m of s.members) {
        const type = this.resolveType(m.type);
        lines.push(`  ${m.name} : ${type},`);
      }
      lines.push(`}`);
      lines.push('');
    }
  }

  private emitFunction(func: FunctionDef, isEntryPoint: boolean, lines: string[], options: WgslOptions, ir: IRDocument) {
    if (isEntryPoint) {
      lines.push(`@compute @workgroup_size(1, 1, 1)`);
      lines.push(`fn main(@builtin(global_invocation_id) GlobalInvocationID : vec3<u32>) {`);
    } else {
      // Signature
      const args = func.inputs.map(arg => {
        const type = this.resolveType(arg.type);
        return `${arg.id}: ${type}`;
      }).join(', ');

      let retType = 'void';
      if (func.outputs.length === 1) {
        retType = this.resolveType(func.outputs[0].type);
      } else if (func.outputs.length > 1) {
        console.warn(`[WgslGenerator] Multi-value return not implemented for ${func.id}`);
        retType = 'void';
      }

      const retStr = retType === 'void' ? '' : ` -> ${retType}`;
      lines.push(`fn ${func.id}(${args})${retStr} {`);
    }

    // Locals
    func.localVars.forEach(v => {
      // Arrays need special handling for initialization?
      const type = this.resolveType(v.type);
      let init = v.initialValue !== undefined ? this.formatLiteral(v.initialValue, v.type) : this.formatZero(v.type);

      // If array and default init, formatZero might handle it if type is explicit.
      // But formatZero relies on type string parsing.

      lines.push(`  var l_${v.id} : ${type} = ${init};`);
    });

    this.emitBody(func, lines, options, new Set(), ir);

    lines.push(`}`);
  }

  private emitBody(func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>, ir: IRDocument) {
    // 1. Find Entry Nodes
    const entryNodes = func.nodes.filter(n => {
      // Logic nodes with no incoming execution edge
      const hasExecIn = func.edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op);
    });

    for (const entry of entryNodes) {
      this.emitChain(entry, func, lines, options, visited, ir);
    }
  }

  private isExecutable(op: string) {
    return op.startsWith('cmd_') || op.startsWith('flow_') ||
      op === 'var_set' || op === 'buffer_store' || op === 'texture_store' ||
      op === 'call_func' || op === 'func_return' || op === 'array_set';
  }

  private emitChain(startNode: Node, func: FunctionDef, lines: string[], options: WgslOptions, visited: Set<string>, ir: IRDocument) {
    let curr: Node | undefined = startNode;
    while (curr) {
      if (visited.has(curr.id)) break;
      visited.add(curr.id);

      this.emitNode(curr, func, lines, options, ir);

      // Next
      // Check for flow_branch special handling?
      // flow_branch has 'exec_true', 'exec_false'.
      // emitNode handles expanding branches.
      // So we stop linear chain if it's a branch?
      if (curr.op === 'flow_branch') {
        // Branch handled recursively in emitNode, stop linear chain here?
        // Wait, flow_branch in 'emitNode' usually recursively calls emitChain for true/false blocks.
        // So we should break the loop.
        break;
      }

      // Standard linear next
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
        if (count === 1) {
          lines.push(`  b_globals.data[${idx}] = ${valExpr};`);
        } else if (type === 'float3x3' || type === 'mat3x3<f32>') {
          for (let c = 0; c < 3; c++) {
            for (let r = 0; r < 3; r++) {
              lines.push(`  b_globals.data[${idx + c * 3 + r}] = ${valExpr}[${c}][${r}];`);
            }
          }
        } else if (type === 'float4x4' || type === 'mat4x4<f32>') {
          for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
              lines.push(`  b_globals.data[${idx + c * 4 + r}] = ${valExpr}[${c}][${r}];`);
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
    } else if (node.op === 'array_set') {
      const arr = this.resolveArg(node, 'array', func, options, ir); // Should return l_arr
      const idx = this.resolveArg(node, 'index', func, options, ir);
      const val = this.resolveArg(node, 'value', func, options, ir);
      // This relies on 'arr' resolving to an L-Value (variable name)
      // Ops like var_get return l_xx.
      lines.push(`${indent}${arr}[u32(${idx})] = ${val};`);
    } else if (node.op === 'buffer_store') {
      const idx = this.resolveArg(node, 'index', func, options, ir);
      const val = this.resolveArg(node, 'value', func, options, ir);
      const bufferId = node['buffer'];
      // Resolve buffer type to cast value
      const def = options.resourceDefs?.get(bufferId);
      const type = def?.dataType ? this.resolveType(def.dataType) : 'f32';
      // If type is vec/mat, val should match. If scalar, cast.
      // E.g. f32(val).
      // If inferred type is same, cast is harmless (f32(1.0) -> 1.0).
      lines.push(`${indent}b_${bufferId}.data[u32(${idx})] = ${type}(${val});`);
    } else if (node.op === 'call_func') {
      const funcId = node['func'];
      const targetFunc = ir.functions.find(f => f.id === funcId);
      if (targetFunc) {
        // Resolve Args
        // Inputs: targetFunc.inputs
        // Arguments in node: input.id (Direct property match)
        const args = targetFunc.inputs.map(inp => {
          const argKey = inp.id;
          return this.resolveArg(node, argKey, func, options, ir);
        }).join(', ');

        const callExpr = `${funcId}(${args})`;

        // Handle Return Value:
        // Since 'call_func' is an execution node, we emit the call statement here.
        // If it returns a value, we capture it in a temporary variable (v_nodeID)
        // so that downstream data nodes can reference it later via resolveArg.

        if (targetFunc.outputs.length > 0) {
          lines.push(`${indent}let v_${node.id} = ${callExpr};`);
        } else {
          lines.push(`${indent}${callExpr};`);
        }
      } else {
        lines.push(`${indent}// Unknown function: ${funcId}`);
      }
    } else if (node.op === 'func_return') {
      const val = this.resolveArg(node, 'val', func, options, ir);
      lines.push(`${indent}return ${val};`);
    } else if (node.op === 'cmd_dispatch') {
      const funcId = node['func'];
      // In WGSL, dispatch is implicit by being the entry point.
      // But if we are compiling a CPU-like main that calls a shader func,
      // we treat dispatch as a simple call to that function.
      if (funcId) {
        lines.push(`${indent}${funcId}();`);
      }
    } else if (node.op === 'flow_branch') {
      const cond = this.resolveArg(node, 'cond', func, options, ir);
      // If cond is 'true' or 'false', use directly. Else assume numeric and compare to 0.
      const condExpr = (cond === 'true' || cond === 'false' || cond.includes('==') || cond.includes('!=')) ? cond : `${cond} != 0.0`;
      lines.push(`${indent}if (${condExpr}) {`);
      // True Path
      const trueEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_true');
      if (trueEdge) {
        const trueNode = func.nodes.find(n => n.id === trueEdge.to);
        if (trueNode) this.emitChain(trueNode, func, lines, options, new Set(), ir);
      }
      lines.push(`${indent}} else {`);
      // False Path
      const falseEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_false');
      if (falseEdge) {
        const falseNode = func.nodes.find(n => n.id === falseEdge.to);
        if (falseNode) this.emitChain(falseNode, func, lines, options, new Set(), ir);
      }
      lines.push(`${indent}}`);
    } else if (node.op === 'flow_loop') {
      // For Loop: for (var i = start; i < end; i++)
      const start = this.resolveArg(node, 'start', func, options, ir);
      const end = this.resolveArg(node, 'end', func, options, ir);
      // Loop variable id
      const loopVar = `i_${node.id}`;
      lines.push(`${indent}for (var ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);

      // Body
      const bodyEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_body');
      if (bodyEdge) {
        const bodyNode = func.nodes.find(n => n.id === bodyEdge.to);
        if (bodyNode) this.emitChain(bodyNode, func, lines, options, new Set(), ir);
      }
      lines.push(`${indent}}`);

      // Completed (continue chain after loop)
      const compEdge = func.edges.find(e => e.from === node.id && e.portOut === 'exec_completed');
      if (compEdge) {
        const compNode = func.nodes.find(n => n.id === compEdge.to);
        // Note: The main emitChain loop breaks on flow_* nodes (like flow_branch/loop).
        // But for flow_loop, we want to continue "after" the loop is done.
        // Since we are inside emitNode called by emitChain, and emitChain breaks after,
        // we must manually emit the rest of the chain here?
        // Or remove the 'break' in emitChain for flow_loop?
        // Actually, flow_loop is linear in the sense that 'exec_completed' is the next step.
        // BUT emitChain breaks on flow_*.
        // So we should recursively call emitChain here for the continuation.
        if (compNode) this.emitChain(compNode, func, lines, options, new Set(), ir);
      }
    } else {
      lines.push(`${indent}// Op: ${node.op}`);
    }
  }

  private resolveArg(node: Node, key: string, func: FunctionDef, options: WgslOptions, ir: IRDocument, targetType?: string): string {
    // Special handling for loop_index which refers to a loop node
    if (key === 'loop' && node.op === 'loop_index') {
      // Return the ID of the loop directly? No, we needed the loop var name.
      // Wait, resolveArg is called for inputs.
      // But loop_index has 'loop' property pointing to node ID.
      // We don't call resolveArg for it usually?
      // Ah, compileExpression handles loop_index?
    }
    const edge = func.edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
    if (edge) {
      const src = func.nodes.find(n => n.id === edge.from);
      if (src) {
        // If src is 'call_func', it was executed previously and stored in v_ID
        if (src.op === 'call_func') {
          return `v_${src.id}`;
        }
        // If src is 'var_get', it wraps a local or global
        if (src.op === 'var_get') {
          const varId = src['var'];
          if (func.localVars.some(v => v.id === varId)) return `l_${varId}`; // Local var
          if (options.varMap?.has(varId)) { // Global var
            const idx = options.varMap.get(varId)!;
            const type = options.varTypes?.get(varId) || 'float';
            const count = this.getComponentCount(type);
            if (count === 1) return `b_globals.data[${idx}]`;
            if (type === 'float2' || type === 'vec2<f32>') {
              return `vec2<f32>(b_globals.data[${idx}], b_globals.data[${idx + 1}])`;
            }
            if (type === 'float3' || type === 'vec3<f32>') {
              return `vec3<f32>(b_globals.data[${idx}], b_globals.data[${idx + 1}], b_globals.data[${idx + 2}])`;
            }
            if (type === 'float4' || type === 'vec4<f32>') {
              return `vec4<f32>(b_globals.data[${idx}], b_globals.data[${idx + 1}], b_globals.data[${idx + 2}], b_globals.data[${idx + 3}])`;
            }
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
          // Function Argument?
          if (func.inputs.some(i => i.id === varId)) return varId;
          throw new Error(`Variable '${varId}' is not defined`);
        }
        // If src is 'struct_construct' or 'array_construct' or 'array_extract' etc., compileExpression handles it.
        return this.compileExpression(src, func, options, ir, targetType);
      }
    }
    if (node[key] !== undefined) {
      const val = node[key];
      // Check if literal is a variable name (mimic Executor behavior)
      if (typeof val === 'string') {
        if (func.localVars.some(v => v.id === val)) return `l_${val}`;
        if (options.varMap?.has(val)) {
          const idx = options.varMap.get(val)!;
          return `b_globals.data[${idx}]`;
        }
      }
      return this.formatLiteral(val, targetType || 'unknown');
    }
    return this.formatZero(targetType || 'float'); // Default?
  }

  private compileExpression(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument, targetType?: string | DataType): string {
    if (node.op === 'literal') return this.formatLiteral(node['val'], targetType || 'float');
    if (node.op === 'loop_index') {
      const loopId = node['loop'];
      return `i_${loopId}`;
    }

    // Constructors
    if (node.op === 'float2') return `vec2<f32>(${this.resolveArg(node, 'x', func, options, ir)}, ${this.resolveArg(node, 'y', func, options, ir)})`;
    if (node.op === 'float3') return `vec3<f32>(${this.resolveArg(node, 'x', func, options, ir)}, ${this.resolveArg(node, 'y', func, options, ir)}, ${this.resolveArg(node, 'z', func, options, ir)})`;
    if (node.op === 'float4' || node.op === 'quat') {
      return `vec4<f32>(${this.resolveArg(node, 'x', func, options, ir, 'float')}, ${this.resolveArg(node, 'y', func, options, ir, 'float')}, ${this.resolveArg(node, 'z', func, options, ir, 'float')}, ${this.resolveArg(node, 'w', func, options, ir, 'float')})`;
    }

    if (node.op === 'float3x3' || node.op === 'float4x4') {
      const vals = node['vals'] as number[];
      if (vals) {
        const formatted = vals.map(v => this.formatLiteral(v, 'float'));
        const type = node.op === 'float3x3' ? 'mat3x3<f32>' : 'mat4x4<f32>';
        return `${type}(${formatted.join(', ')})`;
      }
    }

    // Struct Construct
    if (node.op === 'struct_construct') {
      const type = node['type'];
      const structDef = ir.structs?.find(s => s.id === type);
      let args: string[] = [];

      if (structDef) {
        args = structDef.members.map(m => {
          // Find input arg matching member name
          return this.resolveArg(node, m.name, func, options, ir);
        });
      } else {
        console.warn(`[WgslGenerator] Struct def '${type}' not found`);
        // Try to use all properties? No, unsafe.
      }
      return `${type}(${args.join(', ')})`;
    }

    // Array Construct
    if (node.op === 'array_construct') {
      // array<Type, N>(val1, val2...)
      // The node has 'length', 'fill'.
      const len = node['length'];
      const fill = node['fill'];
      if (fill !== undefined) {
        // Try to infer type
        const isInt = typeof fill === 'number' && Number.isInteger(fill);
        const elemType = isInt ? 'i32' : 'f32';
        // Explicitly pass inherited type to formatLiteral so formatLiteral(0, 'i32') -> '0'.
        const vals = new Array(len).fill(null).map(() => this.formatLiteral(fill, elemType));
        return `array<${elemType}, ${len}>(${vals.join(', ')})`;
      }
    }

    // Array Extract
    if (node.op === 'array_extract') {
      const arr = this.resolveArg(node, 'array', func, options, ir);
      const idx = this.resolveArg(node, 'index', func, options, ir);
      return `${arr}[u32(${idx})]`;
    }

    if (node.op === 'color_mix') {
      const a = this.resolveArg(node, 'a', func, options, ir);
      const b = this.resolveArg(node, 'b', func, options, ir);
      return `color_mix_impl(${a}, ${b})`;
    }
    // Swizzles and Element Access
    if (node.op === 'vec_swizzle') {
      const vec = this.resolveArg(node, 'vec', func, options, ir);
      const channels = node['channels'];
      return `${vec}.${channels}`;
    }
    if (node.op === 'vec_get_element') {
      const vec = this.resolveArg(node, 'vec', func, options, ir);
      // We need 'index'. resolveArg of 'index' returns string (e.g. "1.0" or "i").
      // Vector access requires integer or literal int.
      // resolveArg returns formatted float usually? "1.0".
      // `vec[u32(idx)]` ?
      const idx = this.resolveArg(node, 'index', func, options, ir);
      return `${vec}[u32(${idx})]`;
    }
    if (node.op === 'struct_extract') {
      const struct = this.resolveArg(node, 'struct', func, options, ir);
      const field = node['field'];
      return `${struct}.${field}`;
    }

    if (node.op.startsWith('math_') || node.op.startsWith('vec_') || node.op.startsWith('mat_') || node.op.startsWith('quat_')) {
      return this.compileMathOp(node, func, options, ir, targetType);
    }

    if (node.op === 'texture_sample') {
      const tex = node['tex'];
      const uv = this.resolveArg(node, 'uv', func, options, ir, 'vec2<f32>');
      return `sample_${tex}(${uv})`;
    }

    if (node.op === 'texture_store') {
      const tex = node['tex'];
      const coords = this.resolveArg(node, 'coords', func, options, ir);
      const val = this.resolveArg(node, 'value', func, options, ir);
      return `textureStore(${tex}, vec2<i32>(${coords}), ${val})`;
    }

    if (node.op === 'texture_load') {
      const tex = node['tex'];
      const coords = this.resolveArg(node, 'coords', func, options, ir);
      // textureLoad(tex, coords, lod) - assuming lod 0 for now if not provided
      return `textureLoad(${tex}, vec2<i32>(${coords}), 0)`;
    }

    return '0.0'; // Fallback
  }

  private formatLiteral(val: any, type: string | DataType): string {
    if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        // If type explicitly requests float/f32, format as float.
        if (type === 'float' || type === 'f32') return `${val}.0`;
        // If type implies int (or unknown default), format as int.
        return `${val}`;
      }
      return `${val}`;
    }
    if (Array.isArray(val)) {
      // Parse type hint if it's "array<T, N>"
      let elemType = 'f32';
      if (typeof type === 'string' && type.startsWith('array<')) {
        // Extract T
        const match = type.match(/array<(.+),/);
        if (match) elemType = match[1];
      }

      // Construct vector/array
      const comp = val.map(v => this.formatLiteral(v, elemType)).join(', ');

      if (val.length === 2 && (type === 'float2' || type === 'vec2<f32>')) return `vec2<f32>(${comp})`;
      if (val.length === 3 && (type === 'float3' || type === 'vec3<f32>')) return `vec3<f32>(${comp})`;
      if (val.length === 4 && (type === 'float4' || type === 'vec4<f32>')) return `vec4<f32>(${comp})`;

      // If array definition is known (e.g. array<i32, 3>) but val is empty, we must zero init?
      // But val is the literal value. If it is empty array [], it means length 0?
      // If variable has type array<i32, 3>, and init is [], we cannot satisfy it with array constructor of 0 elems.
      // We should use formatZero(type) instead if val is empty/default?
      // But formatLiteral is called with val.
      // If val is [] and expected type is array<i32, 3>, we should fill with zeros?
      if (typeof type === 'string' && type.startsWith('array<') && val.length === 0) {
        return this.formatZero(type);
      }

      // Default array constructor
      return `array<${elemType},${val.length}>(${comp})`;
    }
    if (typeof val === 'boolean') {
      return val ? 'true' : 'false';
    }
    return `${val}`;
  }

  private formatZero(type: string | DataType): string {
    if (type === 'float' || type === 'f32') return '0.0';
    if (type === 'int' || type === 'i32') return '0';
    if (type === 'bool') return 'false';
    if (type === 'float2' || type === 'vec2<f32>') return 'vec2<f32>(0.0)';
    if (type === 'float3' || type === 'vec3<f32>') return 'vec3<f32>(0.0)';
    if (type === 'float4' || type === 'vec4<f32>') return 'vec4<f32>(0.0)';
    if (type === 'float3x3' || type === 'mat3x3<f32>') return 'mat3x3<f32>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)';
    if (type === 'float4x4' || type === 'mat4x4<f32>') return 'mat4x4<f32>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)';

    // Array zero init
    if (typeof type === 'string' && type.startsWith('array<')) {
      return `${type}()`; // Zero-init constructor syntax? "array<i32, 3>()" is valid in WGSL (default construct).
    }

    return '0.0';
  }

  private compileMathOp(node: Node, func: FunctionDef, options: WgslOptions, ir: IRDocument, targetType?: string | DataType): string {
    const op = node.op;
    const effectiveType = targetType || options.nodeTypes?.get(node.id) || 'float';
    const zero = this.formatZero(effectiveType);
    const one = this.formatOne(effectiveType);

    const a = (k = 'a') => this.resolveArg(node, k, func, options, ir);
    const b = (k = 'b') => this.resolveArg(node, k, func, options, ir);
    const val = (k = 'val') => this.resolveArg(node, k, func, options, ir);

    // Basic Arithmetic
    if (op === 'math_add') return `(${a()} + ${b()})`;
    if (op === 'math_sub') return `(${a()} - ${b()})`;
    if (op === 'math_mul') return `(${a()} * ${b()})`;
    if (op === 'math_div') return `(${a()} / ${b()})`;
    if (op === 'math_mod') return `(${a()} - ${b()} * floor(${a()} / ${b()}))`;
    if (op === 'math_mad') return `fma(${a()}, ${b()}, ${this.resolveArg(node, 'c', func, options, ir)})`;

    // Unary Main
    if (op === 'math_abs') return `abs(${val()})`;
    if (op === 'math_floor') return `floor(${val()})`;
    if (op === 'math_ceil') return `ceil(${val()})`;
    if (op === 'math_fract') return `fract(${val()})`;

    if (op === 'quat_identity') return 'vec4<f32>(0.0, 0.0, 0.0, 1.0)';
    if (op === 'quat_mul') {
      return `vec4<f32>(${a()}.w * ${b()}.xyz + ${b()}.w * ${a()}.xyz + cross(${a()}.xyz, ${b()}.xyz), ${a()}.w * ${b()}.w - dot(${a()}.xyz, ${b()}.xyz))`;
    }
    if (op === 'quat_rotate') {
      const q = this.resolveArg(node, 'q', func, options, ir);
      const v = this.resolveArg(node, 'v', func, options, ir);
      return `(${v} + 2.0 * cross(${q}.xyz, cross(${q}.xyz, ${v}) + ${q}.w * ${v}))`;
    }
    if (op === 'quat_slerp') {
      // ... helper already added above or add here
      this.addHelper(`
fn quat_slerp_impl(q1: vec4<f32>, q2: vec4<f32>, t: f32) -> vec4<f32> {
  var dot_val = dot(q1, q2);
  var q2_prime = q2;
  if (dot_val < 0.0) { dot_val = -dot_val; q2_prime = -q2; }
  if (dot_val > 0.9995) { return normalize(mix(q1, q2_prime, t)); }
  let theta_0 = acos(clamp(dot_val, -1.0, 1.0));
  let theta = theta_0 * t;
  let q3 = normalize(q2_prime - q1 * dot_val);
  return q1 * cos(theta) + q3 * sin(theta);
}
      `);
      return `quat_slerp_impl(${this.resolveArg(node, 'a', func, options, ir)}, ${this.resolveArg(node, 'b', func, options, ir)}, ${this.resolveArg(node, 't', func, options, ir, 'float')})`;
    }
    if (op === 'quat_to_mat4' || op === 'quat_to_float4x4') {
      const q = this.resolveArg(node, 'q', func, options, ir);
      // Quat to Mat4 (Column major)
      return `mat4x4<f32>(
        1.0 - 2.0*(${q}.y*${q}.y + ${q}.z*${q}.z), 2.0*(${q}.x*${q}.y + ${q}.w*${q}.z), 2.0*(${q}.x*${q}.z - ${q}.w*${q}.y), 0.0,
        2.0*(${q}.x*${q}.y - ${q}.w*${q}.z), 1.0 - 2.0*(${q}.x*${q}.x + ${q}.z*${q}.z), 2.0*(${q}.y*${q}.z + ${q}.w*${q}.x), 0.0,
        2.0*(${q}.x*${q}.z + ${q}.w*${q}.y), 2.0*(${q}.y*${q}.z - ${q}.w*${q}.x), 1.0 - 2.0*(${q}.x*${q}.x + ${q}.y*${q}.y), 0.0,
        0.0, 0.0, 0.0, 1.0
      )`;
    }

    if (op === 'mat_identity') {
      const size = node['size'];
      if (size === 3) return 'mat3x3<f32>(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)';
      return 'mat4x4<f32>(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)';
    }
    if (op === 'mat_mul') return `(${a()} * ${b()})`;
    if (op === 'mat_transpose') return `transpose(${val()})`;
    if (op === 'mat_inverse') return `inverse(${val()})`; // Note: WGSL doesn't have inverse! We might need a polyfill.

    // Quaternion Ops (Wait for common-math.wgsl or inject polyfills)
    // For now, let's assume we need to implement them or they are external.
    if (op === 'quat_mul') return `/* TODO: quat_mul */ 0.0`;
    if (op === 'quat_rotate') return `/* TODO: quat_rotate */ 0.0`;
    if (op === 'quat_slerp') return `/* TODO: quat_slerp */ 0.0`;
    if (op === 'quat_to_mat4') return `/* TODO: quat_to_mat4 */ 0.0`;

    // Trig & Transcendental
    if (op === 'math_sqrt') return `sqrt(${val()})`;
    if (op === 'math_is_nan') {
      const v = val();
      const count = this.getComponentCount(effectiveType);
      const uType = count === 1 ? 'u32' : `vec${count}<u32>`;
      const bType = count === 1 ? 'u32' : `vec${count}<u32>`;

      const mask = count === 1 ? '0x7fffffffu' : `${uType}(0x7fffffffu)`;
      const inf = count === 1 ? '0x7f800000u' : `${uType}(0x7f800000u)`;

      return `select(${zero}, ${one}, (bitcast<${uType}>(${v}) & ${mask}) > ${inf})`;
    }
    if (op === 'math_is_inf') return `select(${zero}, ${one}, isinf(${val()}))`;
    if (op === 'math_log') return `log(${val()})`;
    if (op === 'math_sin') return `sin(${val()})`;
    if (op === 'math_cos') return `cos(${val()})`;
    if (op === 'math_tan') return `tan(${val()})`;
    if (op === 'math_tanh') return `tanh(${val()})`;
    if (op === 'math_atan') return `atan(${val()})`;
    if (op === 'math_sign') return `sign(${val()})`;

    // Binary / Ternary
    if (op === 'math_pow') return `pow(${a()}, ${b()})`;
    if (op === 'math_min') return `min(${a()}, ${b()})`;
    if (op === 'math_max') return `max(${a()}, ${b()})`;
    if (op === 'math_clamp') return `clamp(${val()}, ${this.resolveArg(node, 'min', func, options, ir)}, ${this.resolveArg(node, 'max', func, options, ir)})`;
    if (op === 'math_atan2') return `atan2(${this.resolveArg(node, 'a', func, options, ir)}, ${this.resolveArg(node, 'b', func, options, ir)})`;
    if (op === 'math_mix') return `mix(${a()}, ${b()}, ${this.resolveArg(node, 't', func, options, ir)})`;

    if (op === 'vec_dot') return `dot(${a()}, ${b()})`;
    if (op === 'vec_length') return `length(${this.resolveArg(node, 'a', func, options, ir) === '0.0' ? val('val') : this.resolveArg(node, 'a', func, options, ir)})`;
    if (op === 'vec_normalize') return `normalize(${this.resolveArg(node, 'a', func, options, ir)})`;
    if (op === 'vec_mix') return `mix(${a()}, ${b()}, ${this.resolveArg(node, 't', func, options, ir)})`;

    // Logic & Cmparison (Returns bool? Cast to float?)
    if (op === 'math_lt') return `select(${zero}, ${one}, ${a()} < ${b()})`;
    if (op === 'math_gt') return `select(${zero}, ${one}, ${a()} > ${b()})`;
    if (op === 'math_le') return `select(${zero}, ${one}, ${a()} <= ${b()})`;
    if (op === 'math_ge') return `select(${zero}, ${one}, ${a()} >= ${b()})`;
    if (op === 'math_eq') return `select(${zero}, ${one}, ${a()} == ${b()})`;
    if (op === 'math_neq') return `select(${zero}, ${one}, ${a()} != ${b()})`;

    // Boolean Logic (assuming scalar 0.0/1.0 inputs or bools)
    // If inputs are floats (from select), we need `!= 0.0`.
    // WGSL logic `&`, `|` are for bools.
    const toBool = (expr: string) => `(${expr} != 0.0)`;
    if (op === 'math_and') return `select(0.0, 1.0, ${toBool(a())} && ${toBool(b())})`;
    if (op === 'math_or') return `select(0.0, 1.0, ${toBool(a())} || ${toBool(b())})`;
    if (op === 'math_xor') return `select(0.0, 1.0, ${toBool(a())} != ${toBool(b())})`; // XOR for bools is !=
    if (op === 'math_not') return `select(0.0, 1.0, !${toBool(val())})`;

    // Constants
    if (op === 'math_pi') return '3.14159265359';
    if (op === 'math_e') return '2.71828182846';

    return `/* ${op} */ 0.0`;
  }

  private resolveType(type: DataType | string): string {
    // console.log(`[WgslGenerator] Resolving type: '${type}'`);
    // Map IR types to WGSL types
    if (type === 'float' || type === 'f32') return 'f32';
    if (type === 'int' || type === 'i32') return 'i32';
    if (type === 'bool') return 'bool';
    if (type === 'float2' || type === 'vec2<f32>') return 'vec2<f32>';
    if (type === 'float3' || type === 'vec3<f32>') return 'vec3<f32>';
    if (type === 'float4' || type === 'vec4<f32>') return 'vec4<f32>';
    if (type === 'float3x3' || type === 'mat3x3<f32>') return 'mat3x3<f32>';
    if (type === 'float4x4' || type === 'mat4x4<f32>') return 'mat4x4<f32>';

    // Fallback: Assume it's a struct name or user type
    // In strict mode we should check in IR.
    return type; // Default
  }

  private getComponentCount(type: DataType | string): number {
    if (type === 'float2' || type === 'vec2<f32>') return 2;
    if (type === 'float3' || type === 'vec3<f32>') return 3;
    if (type === 'float4' || type === 'vec4<f32>') return 4;
    if (type === 'float3x3' || type === 'mat3x3<f32>') return 9;
    if (type === 'float4x4' || type === 'mat4x4<f32>') return 16;
    return 1;
  }

  private formatOne(type: string | DataType): string {
    if (type === 'float' || type === 'f32') return '1.0';
    if (type === 'int' || type === 'i32') return '1';
    if (type === 'bool') return 'true';
    if (type === 'float2' || type === 'vec2<f32>') return 'vec2<f32>(1.0)';
    if (type === 'float3' || type === 'vec3<f32>') return 'vec3<f32>(1.0)';
    if (type === 'float4' || type === 'vec4<f32>') return 'vec4<f32>(1.0)';
    return '1.0';
  }
}
