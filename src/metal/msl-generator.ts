/**
 * MSL Generator
 * Generates Metal Shading Language code from IR for GPU compute execution.
 */

import { IRDocument, FunctionDef, Node, Edge, StructDef } from '../ir/types';
import { reconstructEdges } from '../ir/utils';
import { inferFunctionTypes, InferredTypes } from '../ir/validator';

export interface MslOptions {
  globalBufferBinding?: number;
  varMap?: Map<string, number>;
  resourceBindings?: Map<string, number>;
  /** Custom kernel function name (default: 'main_kernel') */
  kernelName?: string;
  /** Skip Metal header (include, namespace) */
  skipHeader?: boolean;
  /** Shader stages: map entry point ID to 'vertex' | 'fragment' | 'compute' */
  stages?: Map<string, 'vertex' | 'fragment' | 'compute'>;
}

export interface MslCompilationResult {
  code: string;
  metadata: {
    resourceBindings: Map<string, number>;
    globalBufferSize: number;
    varMap: Map<string, number>;
  };
}

export class MslGenerator {
  private ir?: IRDocument;

  compile(ir: IRDocument, entryPointId: string, options: MslOptions = {}): MslCompilationResult {
    this.ir = ir;
    const lines: string[] = [];

    // Metal header
    if (!options.skipHeader) {
      lines.push('#include <metal_stdlib>');
      lines.push('using namespace metal;');
      lines.push('');
    }

    // Find entry function and collect dependencies
    const entryFunc = ir.functions.find(f => f.id === entryPointId);
    if (!entryFunc) throw new Error(`Entry point '${entryPointId}' not found`);

    const allFunctions = this.collectFunctions(entryFunc, ir.functions);

    // Infer types for all functions
    const inferredTypes = new Map<string, InferredTypes>();
    for (const func of allFunctions) {
      inferredTypes.set(func.id, inferFunctionTypes(func, ir));
    }

    // Analyze variables for globals buffer allocation
    const varMap = options.varMap || new Map<string, number>();
    let varOffset = 0;

    // Allocate space for inputs.
    // Use IR-global inputs and entry point inputs.
    const inputs = [...(ir.inputs || [])];
    if (entryFunc.type === 'shader' && entryFunc.inputs) {
      for (const inp of entryFunc.inputs) {
        if (!inputs.some(i => i.id === inp.id)) inputs.push(inp);
      }
    }

    inputs.forEach(input => {
      if (!varMap.has(input.id)) {
        varMap.set(input.id, varOffset);
        varOffset += this.getTypeFlatSize(input.type);
      }
    });

    // Allocate space for local vars and any var_set targets
    for (const func of allFunctions) {
      for (const v of func.localVars || []) {
        if (!varMap.has(v.id)) {
          varMap.set(v.id, varOffset);
          varOffset += this.getTypeSize(v.type || 'float');
        }
      }
      for (const node of func.nodes) {
        if (node.op === 'var_set') {
          const varId = node['var'];
          if (!varMap.has(varId)) {
            varMap.set(varId, varOffset);
            varOffset++;
          }
        }
      }
    }

    const globalBufferSize = Math.max(varOffset * 4, 16);

    // Resource bindings
    const resourceBindings = options.resourceBindings || new Map<string, number>();
    let bindingCounter = 1; // 0 is reserved for globals

    // 1. Outputs first
    for (const res of ir.resources || []) {
      if (res.isOutput && !resourceBindings.has(res.id)) {
        resourceBindings.set(res.id, bindingCounter++);
      }
    }
    // 2. Texture inputs second
    for (const input of ir.inputs || []) {
      if (input.type === 'texture2d' && !resourceBindings.has(input.id)) {
        resourceBindings.set(input.id, bindingCounter++);
      }
    }
    // 3. Other internal resources last
    for (const res of ir.resources || []) {
      if (!res.isOutput && !resourceBindings.has(res.id)) {
        resourceBindings.set(res.id, bindingCounter++);
      }
    }

    // Emit struct definitions
    this.emitStructs(ir.structs || [], lines);

    // Emit helper functions
    this.emitHelperFunctions(lines);

    // Emit non-entry functions
    for (const func of allFunctions) {
      if (func.id !== entryPointId) {
        this.emitFunction(func, false, lines, allFunctions, varMap, resourceBindings, inferredTypes);
      }
    }

    // Emit entry point as kernel
    this.emitKernel(entryFunc, lines, allFunctions, varMap, resourceBindings, options, inferredTypes);

    return {
      code: lines.join('\n'),
      metadata: {
        resourceBindings,
        globalBufferSize,
        varMap
      }
    };
  }

  /**
   * Compiles multiple entry points into a single Metal library source string.
   */
  compileLibrary(ir: IRDocument, entryPointIds: string[], options: MslOptions = {}): MslCompilationResult {
    this.ir = ir;
    const lines: string[] = [];

    // Metal header
    if (!options.skipHeader) {
      lines.push('#include <metal_stdlib>');
      lines.push('using namespace metal;');
      lines.push('');
    }

    // Emit helper functions
    this.emitHelperFunctions(lines);

    // Emit struct definitions
    this.emitStructs(ir.structs || [], lines);

    const emittedFunctions = new Set<string>();
    const varMap = options.varMap || new Map<string, number>();
    const resourceBindings = options.resourceBindings || new Map<string, number>();
    let varOffset = 0;

    // Default resource bindings if not provided
    if (!options.resourceBindings) {
      let bindingCounter = 1;
      // 1. Outputs first
      for (const res of ir.resources || []) {
        if (res.isOutput && !resourceBindings.has(res.id)) {
          resourceBindings.set(res.id, bindingCounter++);
        }
      }
      // 2. Texture inputs second
      for (const input of ir.inputs || []) {
        if (input.type === 'texture2d' && !resourceBindings.has(input.id)) {
          resourceBindings.set(input.id, bindingCounter++);
        }
      }
      // 3. Other internal resources last
      for (const res of ir.resources || []) {
        if (!res.isOutput && !resourceBindings.has(res.id)) {
          resourceBindings.set(res.id, bindingCounter++);
        }
      }
    }

    for (const entryId of entryPointIds) {
      const entryFunc = ir.functions.find(f => f.id === entryId);
      if (!entryFunc) continue;

      const allFunctions = this.collectFunctions(entryFunc, ir.functions);

      // Infer types for all functions
      const inferredTypes = new Map<string, InferredTypes>();
      for (const func of allFunctions) {
        inferredTypes.set(func.id, inferFunctionTypes(func, ir));
      }

      // Allocate varMap for inputs and local vars (same as compile())
      // Use shader's own inputs if present, otherwise use IR globals
      const funcInputs = (entryFunc.type === 'shader' ? entryFunc.inputs : ir.inputs) || [];
      for (const input of funcInputs) {
        if (!varMap.has(input.id)) {
          varMap.set(input.id, varOffset);
          varOffset += this.getTypeSize(input.type);
        }
      }
      // Also allocate IR global inputs for input inheritance (var_get on globals)
      for (const input of ir.inputs || []) {
        if (!varMap.has(input.id)) {
          varMap.set(input.id, varOffset);
          varOffset += this.getTypeSize(input.type);
        }
      }
      for (const func of allFunctions) {
        for (const v of func.localVars || []) {
          if (!varMap.has(v.id)) {
            varMap.set(v.id, varOffset);
            varOffset += this.getTypeSize(v.type || 'float');
          }
        }
        for (const node of func.nodes) {
          if (node.op === 'var_set') {
            const varId = node['var'];
            if (!varMap.has(varId)) {
              varMap.set(varId, varOffset);
              varOffset++;
            }
          }
        }
      }

      // Emit non-entry functions
      for (const func of allFunctions) {
        if (func.id !== entryId && !emittedFunctions.has(func.id)) {
          this.emitFunction(func, false, lines, allFunctions, varMap, resourceBindings, inferredTypes);
          emittedFunctions.add(func.id);
        }
      }

      // Emit entry point as kernel or stage function
      const stage = options.stages?.get(entryId) || 'compute';
      if (stage === 'vertex' || stage === 'fragment') {
        this.emitStageFunction(entryFunc, stage, lines, allFunctions, resourceBindings, options, inferredTypes);
      } else {
        const kernelOptions = { ...options, kernelName: entryId };
        this.emitKernel(entryFunc, lines, allFunctions, varMap, resourceBindings, kernelOptions, inferredTypes);
      }
      lines.push('');
    }

    const globalBufferSize = Math.max(varOffset * 4, 16);

    return {
      code: lines.join('\n'),
      metadata: {
        resourceBindings,
        globalBufferSize,
        varMap
      }
    };
  }

  private collectFunctions(entry: FunctionDef, all: FunctionDef[]): FunctionDef[] {
    const collected = new Set<string>();
    const result: FunctionDef[] = [];

    // DFS with cycle detection
    const visiting = new Set<string>();
    const visit = (func: FunctionDef) => {
      if (collected.has(func.id)) return;
      if (visiting.has(func.id)) {
        throw new Error(`Recursion detected: cyclic dependency involving '${func.id}'`);
      }
      visiting.add(func.id);
      for (const node of func.nodes) {
        if (node.op === 'call_func') {
          const targetId = node['func'];
          // Self-recursion
          if (targetId === func.id) {
            throw new Error(`Recursion detected: '${func.id}' calls itself`);
          }
          const target = all.find(f => f.id === targetId);
          if (target) visit(target);
        }
      }
      visiting.delete(func.id);
      collected.add(func.id);
      result.push(func);
    };

    visit(entry);
    return result;
  }

  private emitStructs(structs: StructDef[], lines: string[]) {
    if (structs.length === 0) return;

    lines.push('// Struct definitions');
    for (const s of structs) {
      lines.push(`struct ${this.sanitizeId(s.id, 'struct')} {`);
      for (const m of s.members || []) {
        const mslType = this.irTypeToMsl(m.type);
        const attr = m.builtin === 'position' ? ' [[position]]' : '';
        lines.push(`    ${mslType} ${this.sanitizeId(m.name, 'field')}${attr};`);
      }
      lines.push('};');
    }
    lines.push('');
  }

  private emitHelperFunctions(lines: string[]) {
    lines.push('// Helper functions');
    // Safe division
    lines.push('inline float safe_div(float a, float b) { return b != 0.0f ? a / b : 0.0f; }');
    lines.push('inline float2 safe_div(float2 a, float b) { return b != 0.0f ? a / b : float2(0.0f); }');
    lines.push('inline float3 safe_div(float3 a, float b) { return b != 0.0f ? a / b : float3(0.0f); }');
    lines.push('inline float4 safe_div(float4 a, float b) { return b != 0.0f ? a / b : float4(0.0f); }');
    lines.push('inline float2 safe_div(float2 a, float2 b) { return float2(safe_div(a.x, b.x), safe_div(a.y, b.y)); }');
    lines.push('inline float3 safe_div(float3 a, float3 b) { return float3(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z)); }');
    lines.push('inline float4 safe_div(float4 a, float4 b) { return float4(safe_div(a.x, b.x), safe_div(a.y, b.y), safe_div(a.z, b.z), safe_div(a.w, b.w)); }');
    lines.push('');
    // Comparison helpers — overloaded for scalar and vector types
    lines.push('inline float cmp_eq(float a, float b) { return a == b ? 1.0f : 0.0f; }');
    lines.push('inline float2 cmp_eq(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a == b); }');
    lines.push('inline float3 cmp_eq(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a == b); }');
    lines.push('inline float4 cmp_eq(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a == b); }');
    lines.push('inline float cmp_neq(float a, float b) { return a != b ? 1.0f : 0.0f; }');
    lines.push('inline float2 cmp_neq(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a != b); }');
    lines.push('inline float3 cmp_neq(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a != b); }');
    lines.push('inline float4 cmp_neq(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a != b); }');
    lines.push('inline float cmp_lt(float a, float b) { return a < b ? 1.0f : 0.0f; }');
    lines.push('inline float2 cmp_lt(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a < b); }');
    lines.push('inline float3 cmp_lt(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a < b); }');
    lines.push('inline float4 cmp_lt(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a < b); }');
    lines.push('inline float cmp_lte(float a, float b) { return a <= b ? 1.0f : 0.0f; }');
    lines.push('inline float2 cmp_lte(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a <= b); }');
    lines.push('inline float3 cmp_lte(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a <= b); }');
    lines.push('inline float4 cmp_lte(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a <= b); }');
    lines.push('inline float cmp_gt(float a, float b) { return a > b ? 1.0f : 0.0f; }');
    lines.push('inline float2 cmp_gt(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a > b); }');
    lines.push('inline float3 cmp_gt(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a > b); }');
    lines.push('inline float4 cmp_gt(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a > b); }');
    lines.push('inline float cmp_gte(float a, float b) { return a >= b ? 1.0f : 0.0f; }');
    lines.push('inline float2 cmp_gte(float2 a, float2 b) { return select(float2(0.0f), float2(1.0f), a >= b); }');
    lines.push('inline float3 cmp_gte(float3 a, float3 b) { return select(float3(0.0f), float3(1.0f), a >= b); }');
    lines.push('inline float4 cmp_gte(float4 a, float4 b) { return select(float4(0.0f), float4(1.0f), a >= b); }');
    lines.push('');
    // Select helper — overloaded for scalar and vector types
    lines.push('inline float msl_select(float f, float t, float cond) { return cond != 0.0f ? t : f; }');
    lines.push('inline float2 msl_select(float2 f, float2 t, float cond) { return cond != 0.0f ? t : f; }');
    lines.push('inline float3 msl_select(float3 f, float3 t, float cond) { return cond != 0.0f ? t : f; }');
    lines.push('inline float4 msl_select(float4 f, float4 t, float cond) { return cond != 0.0f ? t : f; }');
    lines.push('inline float2 msl_select(float2 f, float2 t, float2 cond) { return select(f, t, cond != 0.0f); }');
    lines.push('inline float3 msl_select(float3 f, float3 t, float3 cond) { return select(f, t, cond != 0.0f); }');
    lines.push('inline float4 msl_select(float4 f, float4 t, float4 cond) { return select(f, t, cond != 0.0f); }');
    lines.push('');
    // NaN/Inf/Finite helpers — overloaded for scalar and vector
    lines.push('inline float msl_is_nan(float v) { return isnan(v) ? 1.0f : 0.0f; }');
    lines.push('inline float2 msl_is_nan(float2 v) { return select(float2(0.0f), float2(1.0f), isnan(v)); }');
    lines.push('inline float3 msl_is_nan(float3 v) { return select(float3(0.0f), float3(1.0f), isnan(v)); }');
    lines.push('inline float4 msl_is_nan(float4 v) { return select(float4(0.0f), float4(1.0f), isnan(v)); }');
    lines.push('inline float msl_is_inf(float v) { return isinf(v) ? 1.0f : 0.0f; }');
    lines.push('inline float2 msl_is_inf(float2 v) { return select(float2(0.0f), float2(1.0f), isinf(v)); }');
    lines.push('inline float3 msl_is_inf(float3 v) { return select(float3(0.0f), float3(1.0f), isinf(v)); }');
    lines.push('inline float4 msl_is_inf(float4 v) { return select(float4(0.0f), float4(1.0f), isinf(v)); }');
    lines.push('inline float msl_is_finite(float v) { return (!isnan(v) && !isinf(v)) ? 1.0f : 0.0f; }');
    lines.push('inline float2 msl_is_finite(float2 v) { return select(float2(0.0f), float2(1.0f), !isnan(v) && !isinf(v)); }');
    lines.push('inline float3 msl_is_finite(float3 v) { return select(float3(0.0f), float3(1.0f), !isnan(v) && !isinf(v)); }');
    lines.push('inline float4 msl_is_finite(float4 v) { return select(float4(0.0f), float4(1.0f), !isnan(v) && !isinf(v)); }');
    lines.push('');
    // Safe int cast (handles overflow with two's complement wrapping)
    lines.push('inline int safe_cast_int(float v) {');
    lines.push('  if (v >= 2147483648.0f) return int(v - 4294967296.0f);');
    lines.push('  if (v < -2147483648.0f) return int(v + 4294967296.0f);');
    lines.push('  return int(v);');
    lines.push('}');
    lines.push('');
    // Flush subnormal helper
    lines.push('inline float flush_subnormal(float v) { return (v != 0.0f && abs(v) < 1.175494e-38f) ? 0.0f : v; }');
    lines.push('');
    // Exponent/mantissa helpers (IEEE 754)
    lines.push('inline float get_exponent(float v) {');
    lines.push('  if (v == 0.0f) return 0.0f;');
    lines.push('  int exp_val; frexp(v, exp_val);');
    lines.push('  return float(exp_val);');
    lines.push('}');
    lines.push('inline float get_mantissa(float v) {');
    lines.push('  if (v == 0.0f) return 0.0f;');
    lines.push('  int exp_val; return frexp(v, exp_val);');
    lines.push('}');
    lines.push('');
    // Matrix inverse (4x4)
    lines.push('inline float4x4 mat_inverse(float4x4 m) {');
    lines.push('  float4 c0 = m[0], c1 = m[1], c2 = m[2], c3 = m[3];');
    lines.push('  float4 r0, r1, r2, r3;');
    lines.push('  r0.x = c1.y*c2.z*c3.w - c1.y*c2.w*c3.z - c2.y*c1.z*c3.w + c2.y*c1.w*c3.z + c3.y*c1.z*c2.w - c3.y*c1.w*c2.z;');
    lines.push('  r0.y = -c0.y*c2.z*c3.w + c0.y*c2.w*c3.z + c2.y*c0.z*c3.w - c2.y*c0.w*c3.z - c3.y*c0.z*c2.w + c3.y*c0.w*c2.z;');
    lines.push('  r0.z = c0.y*c1.z*c3.w - c0.y*c1.w*c3.z - c1.y*c0.z*c3.w + c1.y*c0.w*c3.z + c3.y*c0.z*c1.w - c3.y*c0.w*c1.z;');
    lines.push('  r0.w = -c0.y*c1.z*c2.w + c0.y*c1.w*c2.z + c1.y*c0.z*c2.w - c1.y*c0.w*c2.z - c2.y*c0.z*c1.w + c2.y*c0.w*c1.z;');
    lines.push('  float det = c0.x*r0.x + c1.x*r0.y + c2.x*r0.z + c3.x*r0.w;');
    lines.push('  if (abs(det) < 1e-10) return m;');
    lines.push('  float invDet = 1.0f / det;');
    lines.push('  r1.x = -c1.x*c2.z*c3.w + c1.x*c2.w*c3.z + c2.x*c1.z*c3.w - c2.x*c1.w*c3.z - c3.x*c1.z*c2.w + c3.x*c1.w*c2.z;');
    lines.push('  r1.y = c0.x*c2.z*c3.w - c0.x*c2.w*c3.z - c2.x*c0.z*c3.w + c2.x*c0.w*c3.z + c3.x*c0.z*c2.w - c3.x*c0.w*c2.z;');
    lines.push('  r1.z = -c0.x*c1.z*c3.w + c0.x*c1.w*c3.z + c1.x*c0.z*c3.w - c1.x*c0.w*c3.z - c3.x*c0.z*c1.w + c3.x*c0.w*c1.z;');
    lines.push('  r1.w = c0.x*c1.z*c2.w - c0.x*c1.w*c2.z - c1.x*c0.z*c2.w + c1.x*c0.w*c2.z + c2.x*c0.z*c1.w - c2.x*c0.w*c1.z;');
    lines.push('  r2.x = c1.x*c2.y*c3.w - c1.x*c2.w*c3.y - c2.x*c1.y*c3.w + c2.x*c1.w*c3.y + c3.x*c1.y*c2.w - c3.x*c1.w*c2.y;');
    lines.push('  r2.y = -c0.x*c2.y*c3.w + c0.x*c2.w*c3.y + c2.x*c0.y*c3.w - c2.x*c0.w*c3.y - c3.x*c0.y*c2.w + c3.x*c0.w*c2.y;');
    lines.push('  r2.z = c0.x*c1.y*c3.w - c0.x*c1.w*c3.y - c1.x*c0.y*c3.w + c1.x*c0.w*c3.y + c3.x*c0.y*c1.w - c3.x*c0.w*c1.y;');
    lines.push('  r2.w = -c0.x*c1.y*c2.w + c0.x*c1.w*c2.y + c1.x*c0.y*c2.w - c1.x*c0.w*c2.y - c2.x*c0.y*c1.w + c2.x*c0.w*c1.y;');
    lines.push('  r3.x = -c1.x*c2.y*c3.z + c1.x*c2.z*c3.y + c2.x*c1.y*c3.z - c2.x*c1.z*c3.y - c3.x*c1.y*c2.z + c3.x*c1.z*c2.y;');
    lines.push('  r3.y = c0.x*c2.y*c3.z - c0.x*c2.z*c3.y - c2.x*c0.y*c3.z + c2.x*c0.z*c3.y + c3.x*c0.y*c2.z - c3.x*c0.z*c2.y;');
    lines.push('  r3.z = -c0.x*c1.y*c3.z + c0.x*c1.z*c3.y + c1.x*c0.y*c3.z - c1.x*c0.z*c3.y - c3.x*c0.y*c1.z + c3.x*c0.z*c1.y;');
    lines.push('  r3.w = c0.x*c1.y*c2.z - c0.x*c1.z*c2.y - c1.x*c0.y*c2.z + c1.x*c0.z*c2.y + c2.x*c0.y*c1.z - c2.x*c0.z*c1.y;');
    lines.push('  return float4x4(r0*invDet, r1*invDet, r2*invDet, r3*invDet);');
    lines.push('}');
    lines.push('');
    // Quaternion helpers (w,x,y,z = q.w,q.x,q.y,q.z ; stored as float4(x,y,z,w))
    lines.push('inline float4 quat_mul(float4 a, float4 b) {');
    lines.push('  return float4(a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,');
    lines.push('                a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,');
    lines.push('                a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,');
    lines.push('                a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z);');
    lines.push('}');
    lines.push('inline float3 quat_rotate(float3 v, float4 q) {');
    lines.push('  float3 u = q.xyz; float s = q.w;');
    lines.push('  return 2.0f*dot(u,v)*u + (s*s - dot(u,u))*v + 2.0f*s*cross(u,v);');
    lines.push('}');
    lines.push('inline float4 quat_slerp(float4 a, float4 b, float t) {');
    lines.push('  float d = dot(a, b);');
    lines.push('  if (d < 0.0f) { b = -b; d = -d; }');
    lines.push('  if (d > 0.9995f) return normalize(mix(a, b, t));');
    lines.push('  float theta = acos(clamp(d, -1.0f, 1.0f));');
    lines.push('  float sn = sin(theta);');
    lines.push('  return (sin((1.0f-t)*theta)/sn)*a + (sin(t*theta)/sn)*b;');
    lines.push('}');
    lines.push('inline float4x4 quat_to_mat4(float4 q) {');
    lines.push('  float x=q.x, y=q.y, z=q.z, w=q.w;');
    lines.push('  return float4x4(');
    lines.push('    float4(1-2*(y*y+z*z), 2*(x*y+w*z), 2*(x*z-w*y), 0),');
    lines.push('    float4(2*(x*y-w*z), 1-2*(x*x+z*z), 2*(y*z+w*x), 0),');
    lines.push('    float4(2*(x*z+w*y), 2*(y*z-w*x), 1-2*(x*x+y*y), 0),');
    lines.push('    float4(0, 0, 0, 1));');
    lines.push('}');
    lines.push('');
    // Color mix (alpha-over compositing: dst=a, src=b)
    lines.push('inline float4 color_mix_impl(float4 dst, float4 src) {');
    lines.push('  float outA = src.w + dst.w * (1.0f - src.w);');
    lines.push('  if (outA < 1e-6f) return float4(0.0f);');
    lines.push('  float3 rgb = (src.xyz * src.w + dst.xyz * dst.w * (1.0f - src.w)) / outA;');
    lines.push('  return float4(rgb, outA);');
    lines.push('}');
    lines.push('');
  }

  private emitFunction(
    func: FunctionDef,
    _isEntry: boolean,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    inferredTypes?: Map<string, InferredTypes>
  ) {
    const returnType = func.outputs && func.outputs.length > 0 ? 'float' : 'void';
    const params = this.buildFuncParams(func);

    lines.push(`${returnType} ${this.sanitizeId(func.id, 'func')}(device float* b_globals${params}) {`);

    const edges = reconstructEdges(func);
    this.emitBody(func, lines, allFunctions, varMap, resourceBindings, edges, false, inferredTypes?.get(func.id));

    lines.push('}');
    lines.push('');
  }

  private emitStageFunction(
    func: FunctionDef,
    stage: 'vertex' | 'fragment',
    lines: string[],
    allFunctions: FunctionDef[],
    resourceBindings: Map<string, number>,
    options: MslOptions,
    inferredTypes?: Map<string, InferredTypes>
  ) {
    const isVertex = stage === 'vertex';
    const entryName = options.kernelName || func.id;
    const outputType = func.outputs?.[0]?.type ? this.irTypeToMsl(func.outputs[0].type) : 'void';

    // Build params: vertex_id for VS, stage_in for FS
    const params: string[] = [];
    if (isVertex) {
      params.push('uint vid [[vertex_id]]');
      // If there are other inputs (e.g. uniforms), they should be buffers
      // But for now, we only support vertex_id driven indexing
    } else {
      // Fragment shader input from proper stage_in struct
      // Find the input that matches the VS output (usually the first input)
      const inputType = func.inputs?.[0]?.type;
      if (inputType) {
        params.push(`${this.irTypeToMsl(inputType)} stage_in [[stage_in]]`);
      }
    }

    // Add resource bindings (textures, buffers) similar to kernel
    // But exclude b_globals since it's not supported for non-compute
    // And exclude 'inputs' buffer - we expect data driven by vertex_id or stage_in
    for (const [resId, binding] of resourceBindings) {
      const res = this.ir?.resources.find(r => r.id === resId) ||
        this.ir?.inputs.find(i => i.id === resId && i.type === 'texture2d');
      if (!res) continue;

      if ('type' in res && res.type === 'buffer') {
        const elemType = this.irTypeToMsl((res as any).dataType || 'float');
        params.push(`device ${elemType}* ${this.sanitizeId(resId, 'buffer')} [[buffer(${binding})]]`);
      } else {
        const isWrite = false; // Render pipeline shaders usually read textures
        if (isWrite) {
          params.push(`texture2d<float, access::write> ${this.sanitizeId(resId)}_tex [[texture(${binding})]]`);
        } else {
          params.push(`texture2d<float> ${this.sanitizeId(resId)}_tex [[texture(${binding})]]`);
          params.push(`sampler ${this.sanitizeId(resId)}_sampler [[sampler(${binding})]]`);
        }
      }
    }

    lines.push(`${stage} ${outputType} ${entryName}(${params.join(', ')}) {`);

    // Preamble: unpack inputs to local vars
    if (isVertex) {
      // For now, map vertex_id to first input if it's int/uint
      const vIdx = func.inputs?.[0];
      if (vIdx) {
        lines.push(`    ${this.irTypeToMsl(vIdx.type)} ${this.sanitizeId(vIdx.id)} = vid;`);
      }
    } else {
      // Fragment: map stage_in members to inputs? Or just map the struct itself?
      // Usually FS takes the struct as a whole.
      // If the function expects separate inputs, we'd need to unpack stage_in.
      // But since we control IR generation, let's assume valid IR passes struct.
      const sIn = func.inputs?.[0];
      if (sIn) {
        lines.push(`    ${this.irTypeToMsl(sIn.type)} ${this.sanitizeId(sIn.id)} = stage_in;`);
      }
    }

    // No varMap needed for globals readback since we return values directly
    const varMap = new Map<string, number>();
    const edges = reconstructEdges(func);

    // Use isKernel=false so func_return emits 'return val;'
    this.emitBody(func, lines, allFunctions, varMap, resourceBindings, edges, false, inferredTypes?.get(func.id));

    lines.push('}');
  }

  private emitKernel(
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    options: MslOptions,
    inferredTypes?: Map<string, InferredTypes>
  ) {
    lines.push('// Kernel entry point');

    // Scan for texture_store nodes to determine write textures
    const writeTextures = new Set<string>();
    for (const f of allFunctions) {
      for (const node of f.nodes) {
        if (node.op === 'texture_store') {
          writeTextures.add(node['tex'] as string);
        }
      }
    }

    // Build kernel signature with buffer bindings
    const bufferParams: string[] = [];

    // Combine IR-global and shader-specific inputs
    const inputs = [...(this.ir?.inputs || [])];
    if (func.type === 'shader' && func.inputs) {
      for (const inp of func.inputs) {
        if (!inputs.some(i => i.id === inp.id)) inputs.push(inp);
      }
    }

    const hasShaderInputs = (func.type === 'shader' || (this.ir?.inputs && this.ir.inputs.length > 0)) && inputs.length > 0;

    bufferParams.push('device float* b_globals [[buffer(0)]]');

    for (const [resId, binding] of resourceBindings) {
      const res = this.ir?.resources.find(r => r.id === resId) ||
        this.ir?.inputs.find(i => i.id === resId && i.type === 'texture2d');
      if (!res) continue;

      if ('type' in res && res.type === 'buffer') {
        const elemType = this.irTypeToMsl((res as any).dataType || 'float');
        bufferParams.push(`device ${elemType}* ${this.sanitizeId(resId, 'buffer')} [[buffer(${binding})]]`);
      } else {
        // Must be texture2d (either from resources or inputs)
        const isWrite = writeTextures.has(resId);
        if (isWrite) {
          bufferParams.push(`texture2d<float, access::write> ${this.sanitizeId(resId)}_tex [[texture(${binding})]]`);
        } else {
          bufferParams.push(`texture2d<float> ${this.sanitizeId(resId)}_tex [[texture(${binding})]]`);
          bufferParams.push(`sampler ${this.sanitizeId(resId)}_sampler [[sampler(${binding})]]`);
        }
      }
    }

    const kernelName = options.kernelName || 'main_kernel';
    lines.push(`kernel void ${kernelName}(`);
    lines.push(`    ${bufferParams.join(',\n    ')},`);
    lines.push('    uint3 gid [[thread_position_in_grid]]) {');

    // Emit input unpacking preamble - reconstruct typed locals from flat float buffer
    if (hasShaderInputs) {
      lines.push('    device float* inputs = b_globals;');
      let offset = 0;
      for (const input of inputs) {
        const irType = input.type || 'float';
        const varName = this.sanitizeId(input.id);
        offset = this.emitUnpackInput(varName, irType, offset, lines);
        if (offset < 0) break;
      }
    }

    // Remove duplicate edges decl if present
    const edges = reconstructEdges(func);
    this.emitBody(func, lines, allFunctions, varMap, resourceBindings, edges, true, inferredTypes?.get(func.id));

    // Kernel epilogue: write all local vars to b_globals for readback
    // (func_return paths do their own writeback and return early)
    if (!hasShaderInputs) {
      lines.push('    // Write local vars to globals for readback');
      for (const v of func.localVars || []) {
        const offset = varMap.get(v.id);
        if (offset === undefined) continue;
        const varName = this.sanitizeId(v.id, 'var');
        const varType = v.type || 'float';
        // Skip array types — they can't be written to a flat float buffer directly
        if (varType.startsWith('array<') || varType.includes('[')) continue;
        const typeSize = this.getTypeSize(varType);
        if (typeSize === 1) {
          lines.push(`    b_globals[${offset}] = ${varName};`);
        } else if (varType === 'float3x3') {
          for (let col = 0; col < 3; col++) {
            for (let row = 0; row < 3; row++) {
              lines.push(`    b_globals[${offset + col * 3 + row}] = ${varName}[${col}][${row}];`);
            }
          }
        } else if (varType === 'float4x4') {
          for (let col = 0; col < 4; col++) {
            for (let row = 0; row < 4; row++) {
              lines.push(`    b_globals[${offset + col * 4 + row}] = ${varName}[${col}][${row}];`);
            }
          }
        } else {
          for (let i = 0; i < typeSize; i++) {
            lines.push(`    b_globals[${offset + i}] = ${varName}[${i}];`);
          }
        }
      }
    }

    lines.push('}');
  }

  private emitBody(
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    edges: Edge[],
    isKernel: boolean = false,
    inferredTypes?: InferredTypes
  ) {
    // Declare local variables with initial values
    for (const v of func.localVars || []) {
      const type = this.irTypeToMsl(v.type || 'float');
      lines.push(`    ${this.formatLocalVarDecl(v.id, type, v.initialValue as number | undefined)};`);
    }
    if ((func.localVars || []).length > 0) lines.push('');

    // Track emitted pure nodes
    const emittedPure = new Set<string>();
    const emitPure = (nodeId: string) => {
      if (emittedPure.has(nodeId)) return;
      const node = func.nodes.find(n => n.id === nodeId);
      if (node && this.hasResult(node.op) && !this.isExecutable(node.op)) {
        // Emit dependencies first
        for (const edge of edges) {
          if (edge.to === nodeId && edge.type === 'data') {
            emitPure(edge.from);
          }
        }
        const expr = this.compileExpression(node, func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
        if (node.op === 'array_construct') {
          let len = node['length'] as number || 1;
          if (Array.isArray(node['values'])) {
            len = node['values'].length;
          }
          lines.push(`    float ${this.nodeResId(node.id)}[${len}] = ${expr};`);
        } else {
          lines.push(`    auto ${this.nodeResId(node.id)} = ${expr};`);
        }
        emittedPure.add(nodeId);
      }
    };

    // Find entry nodes and emit execution chain
    const entryNodes = func.nodes.filter(n =>
      n.op.startsWith('cmd_') ||
      this.isExecutable(n.op) && !edges.some(e => e.to === n.id && e.type === 'execution')
    );

    for (const entry of entryNodes) {
      this.emitChain(entry, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, isKernel, undefined, undefined, inferredTypes);
    }
  }

  private emitChain(
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    isKernel: boolean = false,
    visited: Set<string> = new Set(),
    indent: string = '    ',
    inferredTypes?: InferredTypes
  ) {
    let curr: Node | undefined = node;

    while (curr) {
      if (visited.has(curr.id)) {
        if (curr.op !== 'flow_loop') break;
      }
      visited.add(curr.id);

      // Emit data dependencies
      for (const edge of edges) {
        if (edge.to === curr.id && edge.type === 'data') {
          emitPure(edge.from);
        }
      }
      // Also emit inline references
      for (const k in curr) {
        if (['id', 'op', 'metadata', 'func', 'args', 'dispatch'].includes(k)) continue;
        const val = (curr as any)[k];
        if (typeof val === 'string' && func.nodes.some(n => n.id === val)) emitPure(val);
      }

      // Handle control flow
      if (curr.op === 'flow_branch') {
        this.emitBranch(indent, curr, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, isKernel, new Set(visited), inferredTypes);
        return;
      } else if (curr.op === 'flow_loop') {
        this.emitLoop(indent, curr, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, isKernel, new Set(visited), inferredTypes);
        return;
      } else if (curr.op === 'func_return') {
        const val = this.resolveArg(curr, 'val', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
        if (isKernel) {
          // Kernel functions are void — write return value to globals buffer for readback
          const retVarId = curr['val'];
          if (typeof retVarId === 'string' && varMap.has(retVarId)) {
            const offset = varMap.get(retVarId)!;
            const localVar = func.localVars?.find(v => v.id === retVarId);
            const varType = localVar?.type || 'float';
            const typeSize = localVar ? this.getTypeSize(varType) : 1;
            if (typeSize === 1) {
              lines.push(`${indent}b_globals[${offset}] = ${val};`);
            } else if (varType === 'float3x3') {
              // Matrix: val[col][row]
              for (let col = 0; col < 3; col++) {
                for (let row = 0; row < 3; row++) {
                  lines.push(`${indent}b_globals[${offset + col * 3 + row}] = ${val}[${col}][${row}];`);
                }
              }
            } else if (varType === 'float4x4') {
              for (let col = 0; col < 4; col++) {
                for (let row = 0; row < 4; row++) {
                  lines.push(`${indent}b_globals[${offset + col * 4 + row}] = ${val}[${col}][${row}];`);
                }
              }
            } else {
              // Vector: write each component
              for (let i = 0; i < typeSize; i++) {
                lines.push(`${indent}b_globals[${offset + i}] = ${val}[${i}];`);
              }
            }
          }
          lines.push(`${indent}return;`);
        } else {
          lines.push(`${indent}return ${val};`);
        }
        return;
      } else {
        // Emit this node
        this.emitNode(curr, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, indent, isKernel, inferredTypes);
      }

      // Follow execution edges
      const nextEdge = edges.find(e => e.from === curr!.id && e.type === 'execution' && e.portOut === 'exec_out');
      curr = nextEdge ? func.nodes.find(n => n.id === nextEdge.to) : undefined;
    }
  }

  private emitBranch(
    indent: string,
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    isKernel: boolean,
    visited: Set<string>,
    inferredTypes?: InferredTypes
  ) {
    const cond = this.resolveArg(node, 'cond', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
    lines.push(`${indent}if (${cond}) {`);
    const trueEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_true' && e.type === 'execution');
    const trueNode = trueEdge ? func.nodes.find(n => n.id === trueEdge.to) : undefined;
    if (trueNode) this.emitChain(trueNode, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, isKernel, new Set(visited), indent + '  ', inferredTypes);
    lines.push(`${indent}} else {`);
    const falseEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_false' && e.type === 'execution');
    const falseNode = falseEdge ? func.nodes.find(n => n.id === falseEdge.to) : undefined;
    if (falseNode) this.emitChain(falseNode, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, isKernel, new Set(visited), indent + '  ', inferredTypes);
    lines.push(`${indent}}`);
  }

  private emitLoop(
    indent: string,
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    isKernel: boolean,
    visited: Set<string>,
    inferredTypes?: InferredTypes
  ) {
    // Pre-load dependencies for the completion path (exec_completed)
    // This ensures that any pure nodes used AFTER the loop are emitted BEFORE the loop scope opens.
    // Otherwise, if they are first encountered inside the loop (e.g. if the loop body also uses them),
    // they would be scoped inside the loop and invisible to the completion path.
    const compEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_completed' && e.type === 'execution');
    if (compEdge) {
      this.preloadDependencies(compEdge.to, func, edges, emitPure);
    }

    const start = this.resolveArg(node, 'start', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
    const end = this.resolveArg(node, 'end', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
    const loopVar = `loop_${this.sanitizeId(node.id, 'var')}`;
    lines.push(`${indent}for (int ${loopVar} = int(${start}); ${loopVar} < int(${end}); ${loopVar}++) {`);

    const bodyEdge = edges.find(e => e.from === node.id && e.portOut === 'exec_body' && e.type === 'execution');
    const bodyNode = bodyEdge ? func.nodes.find(n => n.id === bodyEdge.to) : undefined;
    if (bodyNode) this.emitChain(bodyNode, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, isKernel, new Set(visited), indent + '  ', inferredTypes);
    lines.push(`${indent}}`);

    const nextNode = compEdge ? func.nodes.find(n => n.id === compEdge.to) : undefined;
    if (nextNode) this.emitChain(nextNode, func, lines, allFunctions, varMap, resourceBindings, emitPure, edges, isKernel, visited, indent, inferredTypes);
  }

  private preloadDependencies(
    startNodeId: string,
    func: FunctionDef,
    edges: Edge[],
    emitPure: (id: string) => void
  ) {
    // BFS traversal of execution chain to find all data dependencies
    const queue = [startNodeId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const currId = queue.shift()!;
      if (visited.has(currId)) continue;
      visited.add(currId);

      const node = func.nodes.find(n => n.id === currId);
      if (!node) continue;

      // 1. Emit direct data dependencies (edges)
      for (const edge of edges) {
        if (edge.to === currId && edge.type === 'data') {
          emitPure(edge.from);
        }
      }

      // 2. Emit inline references
      for (const k in node) {
        if (['id', 'op', 'metadata', 'func', 'args', 'dispatch'].includes(k)) continue;
        const val = (node as any)[k];
        if (typeof val === 'string' && func.nodes.some(n => n.id === val)) {
          emitPure(val);
        }
      }

      // 3. Follow execution edges
      // Standard chain
      const nextEdge = edges.find(e => e.from === currId && e.type === 'execution' && e.portOut === 'exec_out');
      if (nextEdge) queue.push(nextEdge.to);

      // Branch
      const trueEdge = edges.find(e => e.from === currId && e.type === 'execution' && e.portOut === 'exec_true');
      if (trueEdge) queue.push(trueEdge.to);
      const falseEdge = edges.find(e => e.from === currId && e.type === 'execution' && e.portOut === 'exec_false');
      if (falseEdge) queue.push(falseEdge.to);

      // Loop
      const bodyEdge = edges.find(e => e.from === currId && e.type === 'execution' && e.portOut === 'exec_body');
      if (bodyEdge) queue.push(bodyEdge.to);
      const compEdge = edges.find(e => e.from === currId && e.type === 'execution' && e.portOut === 'exec_completed');
      if (compEdge) queue.push(compEdge.to);
    }
  }

  private emitNode(
    node: Node,
    func: FunctionDef,
    lines: string[],
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    indent: string = '    ',
    isKernel: boolean = false,
    inferredTypes?: InferredTypes
  ) {
    if (node.op === 'var_set') {
      const valNodeRef = node['val'];
      const varId = node['var'];
      const varExpr = this.getVariableExpr(varId, func, varMap);

      // Check if the value is an array_construct - use loop-based init
      const valNode = typeof valNodeRef === 'string' ? func.nodes.find(n => n.id === valNodeRef) : null;
      if (valNode && valNode.op === 'array_construct') {
        const length = valNode['length'] as number || 1;
        const fill = valNode['fill'];
        const fillVal = fill !== undefined ? String(fill) : '0';
        // Emit loop-based initialization
        lines.push(`${indent}for (int _i = 0; _i < ${length}; _i++) ${varExpr}[_i] = ${fillVal};`);
      } else {
        const val = this.resolveArg(node, 'val', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
        lines.push(`${indent}${varExpr} = ${val};`);
      }
    } else if (node.op === 'array_set') {
      const arrayNodeRef = node['array'];
      const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      const val = this.resolveArg(node, 'value', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      // Get the array expression - could be a var_get reference
      const arrExpr = this.resolveArg(node, 'array', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      lines.push(`${indent}${arrExpr}[int(${idx})] = ${val};`);
    } else if (node.op === 'buffer_store') {
      const bufferId = node['buffer'];
      const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      const val = this.resolveArg(node, 'value', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      const bufName = this.sanitizeId(bufferId, 'buffer');
      lines.push(`${indent}${bufName}[int(${idx})] = ${val};`);
    } else if (node.op === 'texture_store') {
      const texId = node['tex'] as string;
      const coords = this.resolveArg(node, 'coords', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      const val = this.resolveArg(node, 'value', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      lines.push(`${indent}${this.sanitizeId(texId)}_tex.write(${val}, uint2(${coords}));`);
    } else if (node.op === 'func_return') {
      const val = this.resolveArg(node, 'val', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      if (isKernel) {
        const retVarId = node['val'];
        if (typeof retVarId === 'string' && varMap.has(retVarId)) {
          const offset = varMap.get(retVarId)!;
          const localVar = func.localVars?.find(v => v.id === retVarId);
          const varType = localVar?.type || 'float';
          const typeSize = localVar ? this.getTypeSize(varType) : 1;
          if (typeSize === 1) {
            lines.push(`${indent}b_globals[${offset}] = ${val};`);
          } else if (varType === 'float3x3') {
            for (let col = 0; col < 3; col++) {
              for (let row = 0; row < 3; row++) {
                lines.push(`${indent}b_globals[${offset + col * 3 + row}] = ${val}[${col}][${row}];`);
              }
            }
          } else if (varType === 'float4x4') {
            for (let col = 0; col < 4; col++) {
              for (let row = 0; row < 4; row++) {
                lines.push(`${indent}b_globals[${offset + col * 4 + row}] = ${val}[${col}][${row}];`);
              }
            }
          } else {
            for (let i = 0; i < typeSize; i++) {
              lines.push(`${indent}b_globals[${offset + i}] = ${val}[${i}];`);
            }
          }
        }
        lines.push(`${indent}return;`);
      } else {
        lines.push(`${indent}return ${val};`);
      }
    } else if (this.hasResult(node.op)) {
      const expr = this.compileExpression(node, func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      lines.push(`    auto ${this.nodeResId(node.id)} = ${expr};`);
    }
  }

  private resolveCoercedArgs(
    node: Node,
    keys: string[],
    mode: 'float' | 'unify',
    func: FunctionDef,
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    inferredTypes?: InferredTypes
  ): string[] {
    const rawArgs = keys.map(k => this.resolveArg(node, k, func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes));

    if (!inferredTypes) return rawArgs;

    const argTypes = keys.map(k => {
      const argId = node[k];
      return typeof argId === 'string' ? inferredTypes.get(argId) || 'float' : 'float';
    });

    if (process.env.MSL_DEBUG) {
      console.log(`[MSL] resolveCoercedArgs op=${node.op} keys=${keys} types=${argTypes} mode=${mode}`);
    }

    if (mode === 'float') {
      return rawArgs.map((arg, i) => {
        const type = argTypes[i];
        if (type === 'int' || type === 'uint' || type === 'boolean') {
          return `float(${arg})`;
        }
        return arg;
      });
    } else if (mode === 'unify') {
      const hasFloat = argTypes.some(t => t.includes('float'));
      if (hasFloat) {
        return rawArgs.map((arg, i) => {
          const type = argTypes[i];
          if (type === 'int' || type === 'uint' || type === 'boolean') {
            return `float(${arg})`;
          }
          return arg;
        });
      }
    }
    return rawArgs;
  }

  private compileExpression(
    node: Node,
    func: FunctionDef,
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    inferredTypes?: InferredTypes
  ): string {
    const a = (key = 'a') => this.resolveArg(node, key, func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
    const b = () => this.resolveArg(node, 'b', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);

    // Helper for simple binary/unary ops using coercion
    const binaryOp = (op: string, mode: 'float' | 'unify') => {
      const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], mode, func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      return `${argA} ${op} ${argB}`;
    };

    const unaryOp = (op: string, mode: 'float' | 'unify', key = 'val') => {
      const [arg] = this.resolveCoercedArgs(node, [key], mode, func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      return `${op}(${arg})`;
    };

    switch (node.op) {
      case 'literal':
      case 'float':
        return this.formatFloat(node['val']);
      case 'int':
        return `${node['val']}`;
      case 'bool':
        return node['val'] ? '1.0f' : '0.0f';

      case 'loop_index': {
        const loopId = node['loop'];
        return `loop_${this.sanitizeId(loopId, 'var')}`;
      }

      case 'var_get': {
        const varId = node['var'];
        return this.getVariableExpr(varId, func, varMap);
      }

      case 'buffer_load': {
        const bufferId = node['buffer'];
        const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
        return `${this.sanitizeId(bufferId, 'buffer')}[int(${idx})]`;
      }

      // Vector constructors
      case 'float2': return `float2(${a('x')}, ${a('y')})`;
      case 'float3': return `float3(${a('x')}, ${a('y')}, ${a('z')})`;
      case 'float4': return `float4(${a('x')}, ${a('y')}, ${a('z')}, ${a('w')})`;

      // Quaternion constructors
      case 'quat': {
        const x = node['x'];
        if (x !== undefined) {
          return `float4(${a('x')}, ${a('y')}, ${a('z')}, ${a('w')})`;
        }
        // axis-angle form
        const [axis, angle] = this.resolveCoercedArgs(node, ['axis', 'angle'], 'float', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
        return `float4(${axis} * sin(${angle} * 0.5f), cos(${angle} * 0.5f))`;
      }
      case 'quat_identity': return 'float4(0.0f, 0.0f, 0.0f, 1.0f)';

      // Matrix constructors
      case 'float3x3': {
        const vals = node['vals'];
        if (Array.isArray(vals)) {
          const formatted = vals.map((v: number) => this.formatFloat(v));
          return `float3x3(${formatted.join(', ')})`;
        } else if (typeof vals === 'string') {
          // Check if source is array_construct — inline the fill value
          const srcNode = func.nodes.find(n => n.id === vals);
          if (srcNode && srcNode.op === 'array_construct') {
            const fill = srcNode['fill'] !== undefined ? srcNode['fill'] as number : 0;
            return `float3x3(${new Array(9).fill(this.formatFloat(fill)).join(', ')})`;
          }
          emitPure(vals);
          const varExpr = this.nodeResId(vals);
          const args = [];
          for (let i = 0; i < 9; i++) args.push(`float(${varExpr}[${i}])`);
          return `float3x3(${args.join(', ')})`;
        }
        return 'float3x3(1,0,0, 0,1,0, 0,0,1)';
      }
      case 'float4x4': {
        const vals = node['vals'];
        if (Array.isArray(vals)) {
          const formatted = vals.map((v: number) => this.formatFloat(v));
          return `float4x4(${formatted.join(', ')})`;
        } else if (typeof vals === 'string') {
          // Check if source is array_construct
          const srcNode = func.nodes.find(n => n.id === vals);
          if (srcNode && srcNode.op === 'array_construct') {
            const fill = srcNode['fill'] !== undefined ? srcNode['fill'] as number : 0;
            return `float4x4(${new Array(16).fill(this.formatFloat(fill)).join(', ')})`;
          }
          emitPure(vals);
          const varExpr = this.nodeResId(vals);
          const args = [];
          for (let i = 0; i < 16; i++) args.push(`float(${varExpr}[${i}])`);
          return `float4x4(${args.join(', ')})`;
        }
        return 'float4x4(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1)';
      }

      // Constants
      case 'math_pi': return '3.14159265358979323846f';
      case 'math_e': return '2.71828182845904523536f';

      // Math Ops
      case 'math_add': return binaryOp('+', 'unify');
      case 'math_mad': return `fma(${a()}, ${b()}, ${a('c')})`;
      case 'math_sub': return binaryOp('-', 'unify');
      case 'math_mul': return binaryOp('*', 'unify');
      case 'math_div': return binaryOp('/', 'unify');
      case 'math_neg': return `(-${a('val')})`;
      case 'math_abs': return unaryOp('abs', 'unify');
      case 'math_sin': return unaryOp('sin', 'float');
      case 'math_cos': return unaryOp('cos', 'float');
      case 'math_tan': return unaryOp('tan', 'float');
      case 'math_asin': return unaryOp('asin', 'float');
      case 'math_acos': return unaryOp('acos', 'float');
      case 'math_atan': return unaryOp('atan', 'float');
      case 'math_atan2': return `atan2(${this.resolveCoercedArgs(node, ['a', 'b'], 'float', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes).join(', ')})`;
      case 'math_sinh': return unaryOp('sinh', 'float');
      case 'math_cosh': return unaryOp('cosh', 'float');
      case 'math_tanh': return unaryOp('tanh', 'float');
      case 'math_floor': return unaryOp('floor', 'float');
      case 'math_ceil': return unaryOp('ceil', 'float');
      case 'math_round': return unaryOp('round', 'float');
      case 'math_sqrt': return unaryOp('sqrt', 'float');
      case 'math_pow': return `pow(${this.resolveCoercedArgs(node, ['a', 'b'], 'float', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes).join(', ')})`;
      case 'math_exp': return unaryOp('exp', 'float');
      case 'math_exp2': return `exp2(${a('val')})`;
      case 'math_log': return unaryOp('log', 'float');
      case 'math_log2': return `log2(${a('val')})`;
      case 'math_min': return `min(${this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes).join(', ')})`;
      case 'math_max': return `max(${this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes).join(', ')})`;
      case 'math_clamp': {
        const [val, minVal, maxVal] = this.resolveCoercedArgs(node, ['val', 'min', 'max'], 'unify', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
        return `clamp(${val}, ${minVal}, ${maxVal})`;
      }
      case 'math_mod': {
        const [argA, argB] = this.resolveCoercedArgs(node, ['a', 'b'], 'unify', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
        // Check inferred type of A
        const typeA = typeof node['a'] === 'string' ? inferredTypes?.get(node['a']) : 'float';
        if (typeA && (typeA === 'int' || typeA === 'uint')) {
          return `(${argA} % ${argB})`;
        }
        return `fmod(${argA}, ${argB})`;
      }
      case 'math_fract': return `fract(${this.resolveCoercedArgs(node, ['val'], 'float', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes)[0]})`;
      case 'math_sign': return unaryOp('sign', 'unify');
      case 'math_step': {
        const [edge, x] = this.resolveCoercedArgs(node, ['edge', 'x'], 'float', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
        return `step(${edge}, ${x})`;
      }
      case 'math_smoothstep': {
        const [edge0, edge1, x] = this.resolveCoercedArgs(node, ['edge0', 'edge1', 'x'], 'float', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
        return `smoothstep(${edge0}, ${edge1}, ${x})`;
      }
      case 'math_mix': return `mix(${this.resolveCoercedArgs(node, ['a', 'b', 't'], 'float', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes).join(', ')})`;
      case 'math_lerp': return `mix(${this.resolveCoercedArgs(node, ['a', 'b', 't'], 'float', func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes).join(', ')})`;
      case 'math_trunc': return `trunc(${a('val')})`;
      case 'math_is_nan': return `msl_is_nan(${a('val')})`;
      case 'math_is_inf': return `msl_is_inf(${a('val')})`;
      case 'math_is_finite': return `msl_is_finite(${a('val')})`;
      case 'math_flush_subnormal': return `flush_subnormal(${a('val')})`;
      case 'math_exponent': return `get_exponent(${a('val')})`;
      case 'math_mantissa': return `get_mantissa(${a('val')})`;

      // Comparisons — use overloaded helpers for vector compatibility
      case 'math_eq': return `cmp_eq(${a()}, ${b()})`;
      case 'math_neq': return `cmp_neq(${a()}, ${b()})`;
      case 'math_lt': return `cmp_lt(${a()}, ${b()})`;
      case 'math_lte': case 'math_le': return `cmp_lte(${a()}, ${b()})`;
      case 'math_gt': return `cmp_gt(${a()}, ${b()})`;
      case 'math_gte': case 'math_ge': return `cmp_gte(${a()}, ${b()})`;

      // Logic ops
      case 'math_and': return `((${a()} != 0.0f && ${b()} != 0.0f) ? 1.0f : 0.0f)`;
      case 'math_or': return `((${a()} != 0.0f || ${b()} != 0.0f) ? 1.0f : 0.0f)`;
      case 'math_not': return `(${a('val')} == 0.0f ? 1.0f : 0.0f)`;
      case 'math_xor': return `(((${a()} != 0.0f) != (${b()} != 0.0f)) ? 1.0f : 0.0f)`;

      // Matrix ops
      case 'mat_identity': {
        const size = node['size'] || 4;
        if (size === 3) return 'float3x3(1,0,0, 0,1,0, 0,0,1)';
        return 'float4x4(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1)';
      }
      case 'mat_mul': return `(${a()} * ${b()})`;
      case 'mat_inverse': return `mat_inverse(${a('val')})`;

      // Quaternion ops
      case 'quat_mul': return `quat_mul(${a()}, ${b()})`;
      case 'quat_rotate': return `quat_rotate(${a('v')}, ${a('q')})`;
      case 'quat_slerp': return `quat_slerp(${a()}, ${b()}, ${a('t')})`;
      case 'quat_to_float4x4': return `quat_to_mat4(${a('q')})`;

      // Color ops
      case 'color_mix': return `color_mix_impl(${a()}, ${b()})`;

      case 'math_select': return `msl_select(${a('false')}, ${a('true')}, ${a('cond')})`;

      // Vector ops
      case 'vec_dot': return `dot(${a()}, ${b()})`;
      case 'vec_length': return `length(${a()})`;
      case 'vec_normalize': return `normalize(${a()})`;
      case 'vec_mix': return `mix(${a()}, ${b()}, ${a('t')})`;
      case 'vec_cross': return `cross(${a()}, ${b()})`;
      case 'vec_distance': return `distance(${a()}, ${b()})`;
      case 'vec_reflect': return `reflect(${a()}, ${a('n')})`;

      case 'vec_swizzle': {
        const vec = this.resolveArg(node, 'vec', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        const channels = node['channels'] || node['swizzle'] || 'x';
        return `${vec}.${channels}`;
      }

      case 'resource_get_size': {
        const resId = node['resource'];
        const resDef = this.ir?.resources.find(r => r.id === resId) ||
          this.ir?.inputs.find(i => i.id === resId && i.type === 'texture2d');

        if (resDef && (resDef.type === 'texture2d')) {
          // For textures in shader context, use runtime Metal calls
          const texName = `${this.sanitizeId(resId)}_tex`;
          return `float2(${texName}.get_width(), ${texName}.get_height())`;
        }
        // For buffers or fixed-size resources, resolve from IR metadata
        const size = resDef && 'size' in resDef && typeof resDef.size === 'object' && 'value' in resDef.size
          ? resDef.size.value : 1;
        if (Array.isArray(size)) {
          return `float2(${this.formatFloat(size[0])}, ${this.formatFloat(size[1])})`;
        }
        if (typeof size === 'number') {
          return `float2(${this.formatFloat(size)}, 1.0f)`;
        }
        return 'float2(1.0f, 1.0f)';
      }

      case 'vec_get_element': {
        const vec = this.resolveArg(node, 'vec', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        // Detect matrix source — need col/row indexing instead of flat
        const targetId = node['vec'] as string;
        if (targetId) {
          const targetNode = func.nodes.find(n => n.id === targetId);
          const targetVar = func.localVars?.find(v => v.id === targetId);
          const op = targetNode?.op;
          const varType = targetVar?.type;
          if (op === 'float3x3' || op === 'float4x4' || op === 'mat_identity' || op === 'mat_inverse' || op === 'mat_transpose' || op === 'quat_to_float4x4' ||
            varType === 'float3x3' || varType === 'float4x4') {
            const size = (op === 'float3x3' || varType === 'float3x3' || (op === 'mat_identity' && targetNode?.['size'] === 3)) ? 3 : 4;
            return `${vec}[int(${idx}) / ${size}][int(${idx}) % ${size}]`;
          }
        }
        return `${vec}[int(${idx})]`;
      }

      // Type casting
      case 'static_cast_float': {
        const valId = node['val'];
        const valExpr = a('val');
        if (typeof valId === 'string') {
          const valNode = func.nodes.find(n => n.id === valId);
          if (valNode) {
            const op = valNode.op;
            const channels = (valNode['channels'] as string) || (valNode['swizzle'] as string);
            if (op === 'float2' || (op === 'vec_swizzle' && channels?.length === 2)) {
              return `float2(${valExpr})`;
            }
            if (op === 'float3' || (op === 'vec_swizzle' && channels?.length === 3)) {
              return `float3(${valExpr})`;
            }
            if (op === 'float4' || (op === 'vec_swizzle' && channels?.length === 4)) {
              return `float4(${valExpr})`;
            }
          }
        }
        return `float(${valExpr})`;
      }
      case 'static_cast_int': return `safe_cast_int(${a('val')})`;
      case 'static_cast_bool': return `(${a('val')} != 0.0f ? 1.0f : 0.0f)`;

      // Struct operations
      case 'struct_construct': {
        const structType = node['type'] as string;
        const valuesObj = node['values'] as Record<string, any> || {};
        const structDef = (this.ir?.structs ?? []).find(s => s.id === structType);
        if (!structDef) throw new Error(`MslGenerator: Struct '${structType}' not found`);

        // Build constructor with members in order
        const memberExprs: string[] = [];
        for (const m of structDef.members || []) {
          const val = valuesObj[m.name];
          if (val !== undefined) {
            if (typeof val === 'number') {
              memberExprs.push(this.formatFloat(val));
            } else if (typeof val === 'string') {
              const refNode = func.nodes.find(n => n.id === val);
              if (refNode) {
                emitPure(val);
                memberExprs.push(this.nodeResId(val));
              } else {
                memberExprs.push(this.getVariableExpr(val, func, varMap));
              }
            } else {
              memberExprs.push(String(val));
            }
          } else {
            memberExprs.push('{}'); // Default init
          }
        }
        return `${this.sanitizeId(structType, 'struct')}{${memberExprs.join(', ')}}`;
      }

      case 'struct_extract': {
        const structExpr = this.resolveArg(node, 'struct', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        const field = node['field'] as string;
        return `${structExpr}.${this.sanitizeId(field, 'field')}`;
      }

      // Array operations
      case 'array_construct': {
        const length = node['length'] as number || 1;
        const values = node['values'];

        if (Array.isArray(values) && values.length > 0) {
          const elements = values.map((v: any) => this.formatFloat(Number(v)));
          return `{ ${elements.join(', ')} }`;
        }

        const fill = node['fill'];
        const fillVal = fill !== undefined ? this.formatFloat(fill as number) : '0.0f';
        // Use Metal array syntax
        const elements = new Array(length).fill(fillVal);
        return `{ ${elements.join(', ')} }`;
      }

      case 'array_extract': {
        const arrExpr = this.resolveArg(node, 'array', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        const idx = this.resolveArg(node, 'index', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        return `${arrExpr}[int(${idx})]`;
      }

      case 'array_length': {
        const arrId = node['array'];
        // For dynamic array inputs, we declared a _len variable in the preamble
        if (typeof arrId === 'string' && func.inputs?.some(i => i.id === arrId)) {
          return `${this.sanitizeId(arrId)}_len`;
        }
        return '0';
      }

      case 'call_func': {
        const targetId = node['func'] as string;
        const targetFunc = allFunctions.find(f => f.id === targetId);
        if (!targetFunc) throw new Error(`MslGenerator: Function '${targetId}' not found`);

        // Build args list matching target function's inputs
        const argExprs: string[] = ['b_globals'];
        for (const inp of targetFunc.inputs || []) {
          const argVal = node['args']?.[inp.id];
          if (argVal !== undefined) {
            if (typeof argVal === 'number') {
              argExprs.push(this.formatFloat(argVal));
            } else if (typeof argVal === 'string') {
              const refNode = func.nodes.find(n => n.id === argVal);
              if (refNode) {
                emitPure(argVal);
                argExprs.push(this.nodeResId(argVal));
              } else {
                argExprs.push(this.getVariableExpr(argVal, func, varMap));
              }
            } else {
              argExprs.push(String(argVal));
            }
          } else {
            argExprs.push('0.0f');
          }
        }
        return `${this.sanitizeId(targetId, 'func')}(${argExprs.join(', ')})`;
      }

      case 'builtin_get': {
        const name = node['name'] as string;
        if (name === 'global_invocation_id') {
          return 'float3(gid)';
        }
        throw new Error(`MSL Generator: Unsupported builtin '${name}'`);
      }

      case 'texture_sample': {
        const texId = node['tex'] as string;
        const coordsExpr = this.resolveArg(node, 'coords', func, allFunctions, varMap, resourceBindings, emitPure, edges);
        // Metal sampling syntax: texture.sample(sampler, uv)
        return `${this.sanitizeId(texId)}_tex.sample(${this.sanitizeId(texId)}_sampler, ${coordsExpr})`;
      }

      default:
        throw new Error(`MSL Generator: Unsupported op '${node.op}'`);
    }
  }

  private getVariableExpr(varId: string, func: FunctionDef, varMap: Map<string, number>): string {
    // Check if it's a shader function input or an IR global input - use the unpacked local variable
    if ((func.type === 'shader' || this.ir?.inputs?.length) &&
      (func.inputs?.some(i => i.id === varId) || this.ir?.inputs?.some(i => i.id === varId))) {
      return this.sanitizeId(varId);
    }

    // Check if it's a local variable
    if (func.localVars?.some(v => v.id === varId)) {
      return this.sanitizeId(varId, 'var');
    }

    const offset = varMap.get(varId);
    if (offset !== undefined) {
      return `b_globals[${offset}]`;
    }

    return this.sanitizeId(varId, 'var'); // Default to local
  }

  private resolveArg(
    node: Node,
    key: string,
    func: FunctionDef,
    allFunctions: FunctionDef[],
    varMap: Map<string, number>,
    resourceBindings: Map<string, number>,
    emitPure: (id: string) => void,
    edges: Edge[],
    inferredTypes?: InferredTypes
  ): string {
    // Check for edge connection
    const edge = edges.find(e => e.to === node.id && (e.portIn === key || (key === 'val' && e.portIn === 'value')) && e.type === 'data');
    if (edge) {
      const source = func.nodes.find(n => n.id === edge.from);
      if (source) {
        // Prevent inlining of complex constructors that emit initializer lists (unless checking length)
        // struct_construct and array_construct emit { ... } which cannot be used in expressions directly
        if ((source.op === 'array_construct' || source.op === 'struct_construct') && node.op !== 'array_length') {
          emitPure(source.id);
          return this.nodeResId(source.id);
        }

        // If the node has a result and is not a "pure" expr we want to inline (like literals usually), use the variable
        // However, we must ensure it's been emitted. Typically nodes are sorted.
        // For now, let's prefer variables for ops that are definitely emitted as variables.
        if (this.hasResult(source.op) && source.op !== 'literal') {
          return this.nodeResId(source.id);
        }

        return this.compileExpression(source, func, allFunctions, varMap, resourceBindings, emitPure, edges, inferredTypes);
      }
    }

    // Check for inline literal
    const val = node[key];
    if (val === undefined) return '0.0f';
    if (typeof val === 'number') return this.formatFloat(val);
    if (typeof val === 'boolean') return val ? '1.0f' : '0.0f';
    if (Array.isArray(val)) {
      // Format as Metal vector
      const len = val.length;
      const elements = val.map((v: number) => this.formatFloat(v)).join(', ');
      if (len === 2) return `float2(${elements})`;
      if (len === 3) return `float3(${elements})`;
      if (len === 4) return `float4(${elements})`;
      return `float${len}(${elements})`;
    }
    if (typeof val === 'string') {
      // Node reference
      const refNode = func.nodes.find(n => n.id === val);
      if (refNode) {
        emitPure(val);
        return this.nodeResId(val);
      }

      // Variable reference (input or local)
      return this.getVariableExpr(val, func, varMap);
    }
    return String(val);
  }

  private hasResult(op: string): boolean {
    const valueOps = [
      'literal', 'float', 'int', 'bool',
      'var_get', 'buffer_load', 'builtin_get',
      'float2', 'float3', 'float4',
      'float3x3', 'float4x4',
      'quat', 'quat_identity',
      'vec_dot', 'vec_length', 'vec_normalize', 'vec_swizzle', 'vec_get_element',
      'static_cast_float', 'static_cast_int', 'static_cast_bool',
      'struct_construct', 'struct_extract',
      'array_construct', 'array_extract', 'array_length',
      'resource_get_size',
      'texture_sample',
      'call_func',
      'mat_identity', 'mat_mul', 'mat_inverse',
      'quat_mul', 'quat_rotate', 'quat_slerp', 'quat_to_float4x4',
      'color_mix'
    ];
    return valueOps.includes(op) || op.startsWith('math_') || op.startsWith('vec_');
  }

  private isExecutable(op: string): boolean {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op === 'var_set' ||
      op === 'buffer_store' || op === 'texture_store' || op === 'func_return' || op === 'call_func' || op === 'array_set';
  }

  private formatFloat(val: number): string {
    const s = val.toString();
    if (!s.includes('.') && !s.includes('e') && !s.includes('E')) {
      return s + '.0f';
    }
    return s + 'f';
  }

  private sanitizeId(id: string, type: 'var' | 'func' | 'struct' | 'field' | 'buffer' = 'var'): string {
    const clean = id.replace(/[^a-zA-Z0-9_]/g, '_');
    if (type === 'func') return `func_${clean}`;
    if (type === 'struct') return `S_${clean}`;
    if (type === 'field') return `f_${clean}`;
    if (type === 'buffer') return `b_${clean}`;
    return `v_${clean}`;
  }

  private nodeResId(id: string): string {
    return `n_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  private irTypeToMsl(irType: string | undefined): string {
    if (!irType) return 'float';
    switch (irType) {
      case 'float': return 'float';
      case 'int': case 'i32': return 'int';
      case 'uint': case 'u32': return 'uint';
      case 'bool': return 'bool';
      case 'float2': return 'float2';
      case 'float3': return 'float3';
      case 'float4': case 'quat': return 'float4';
      case 'float3x3': return 'float3x3';
      case 'float4x4': return 'float4x4';
      default:
        if (irType.startsWith('array<')) {
          // Parse array<elem, len> and return Metal array type
          const match = irType.match(/array<([^,]+),\s*(\d+)>/);
          if (match) {
            const elemType = this.irTypeToMsl(match[1].trim());
            const len = match[2];
            // Return special marker that caller handles for local vars
            return `__array_${elemType}_${len}`;
          }
          return 'float'; // fallback
        }
        return this.sanitizeId(irType, 'struct');
    }
  }

  // Helper to format local var declaration with array handling
  private formatLocalVarDecl(varId: string, type: string, init?: number | number[]): string {
    if (type.startsWith('__array_')) {
      // Parse __array_elemType_len - strip prefix, then split
      const stripped = type.substring('__array_'.length); // e.g., "int_3"
      const lastUnderscore = stripped.lastIndexOf('_');
      const elemType = stripped.substring(0, lastUnderscore);
      const len = stripped.substring(lastUnderscore + 1);
      return `${elemType} ${this.sanitizeId(varId)}[${len}]`;
    }
    let initStr = '';
    if (Array.isArray(init)) {
      // Vector initial value: float4(0, 0, 0, 0)
      initStr = ` = ${type}(${init.map(v => this.formatFloat(v)).join(', ')})`;
    } else if (init !== undefined) {
      initStr = ` = ${this.formatFloat(init)}`;
    }
    return `${type} ${this.sanitizeId(varId)}${initStr}`;
  }

  private getTypeSize(type: string | undefined): number {
    if (!type) return 1;
    if (type === 'float2') return 2;
    if (type === 'float3') return 3;
    if (type === 'float4' || type === 'quat') return 4;
    if (type === 'float3x3') return 9;
    if (type === 'float4x4') return 16;
    return 1;
  }

  private buildFuncParams(func: FunctionDef): string {
    if (!func.inputs || func.inputs.length === 0) return '';
    return ', ' + func.inputs.map(i => `float ${this.sanitizeId(i.id, 'var')}`).join(', ');
  }

  /**
   * Get the flat float count for an IR type (for marshalling through flat float buffer).
   */
  private getTypeFlatSize(irType: string): number {
    switch (irType) {
      case 'float': case 'int': case 'i32': case 'bool': return 1;
      case 'float2': return 2;
      case 'float3': return 3;
      case 'float4': case 'quat': return 4;
      case 'float3x3': return 9;
      case 'float4x4': return 16;
      default: {
        const structDef = this.ir?.structs?.find(s => s.id === irType);
        if (structDef) {
          return (structDef.members || []).reduce((sum, m) => sum + this.getTypeFlatSize(m.type), 0);
        }
        const arrayMatch = irType.match(/array<([^,]+),\s*(\d+)>/);
        if (arrayMatch) {
          return parseInt(arrayMatch[2]) * this.getTypeFlatSize(arrayMatch[1].trim());
        }
        return 1;
      }
    }
  }

  /**
   * Emit code to unpack shader inputs from a flat float buffer into typed local variables.
   */
  private emitInputUnpacking(func: FunctionDef, lines: string[]): void {
    let offset = 0;
    for (const input of func.inputs || []) {
      const irType = input.type || 'float';
      const varName = this.sanitizeId(input.id);
      offset = this.emitUnpackInput(varName, irType, offset, lines);
      if (offset < 0) break; // Dynamic array consumed remainder
    }
  }

  /**
   * Emit unpacking code for a single input variable from the flat float buffer.
   * Returns the new offset, or -1 if the rest of the buffer is consumed (dynamic array).
   */
  private emitUnpackInput(varName: string, irType: string, offset: number, lines: string[]): number {
    switch (irType) {
      case 'float':
        lines.push(`    float ${varName} = inputs[${offset}];`);
        return offset + 1;
      case 'int': case 'i32':
        lines.push(`    int ${varName} = int(inputs[${offset}]);`);
        return offset + 1;
      case 'bool':
        lines.push(`    bool ${varName} = inputs[${offset}] != 0.0f;`);
        return offset + 1;
      case 'float2':
        lines.push(`    float2 ${varName} = float2(inputs[${offset}], inputs[${offset + 1}]);`);
        return offset + 2;
      case 'float3':
        lines.push(`    float3 ${varName} = float3(inputs[${offset}], inputs[${offset + 1}], inputs[${offset + 2}]);`);
        return offset + 3;
      case 'float4':
        lines.push(`    float4 ${varName} = float4(inputs[${offset}], inputs[${offset + 1}], inputs[${offset + 2}], inputs[${offset + 3}]);`);
        return offset + 4;
      case 'float3x3': {
        const indices = Array.from({ length: 9 }, (_, i) => `inputs[${offset + i}]`);
        lines.push(`    float ${varName}[9] = {${indices.join(', ')}};`);
        return offset + 9;
      }
      case 'float4x4': {
        const indices = Array.from({ length: 16 }, (_, i) => `inputs[${offset + i}]`);
        lines.push(`    float ${varName}[16] = {${indices.join(', ')}};`);
        return offset + 16;
      }
      default: {
        // Check for struct type
        const structDef = this.ir?.structs?.find(s => s.id === irType);
        if (structDef) {
          const mslType = this.sanitizeId(irType, 'struct');
          const memberExprs: string[] = [];
          let memberOffset = offset;
          for (const m of structDef.members || []) {
            const mt = m.type;
            if (mt === 'float') {
              memberExprs.push(`inputs[${memberOffset}]`);
              memberOffset += 1;
            } else if (mt === 'int' || mt === 'i32') {
              memberExprs.push(`int(inputs[${memberOffset}])`);
              memberOffset += 1;
            } else if (mt === 'float2') {
              memberExprs.push(`float2(inputs[${memberOffset}], inputs[${memberOffset + 1}])`);
              memberOffset += 2;
            } else if (mt === 'float3') {
              memberExprs.push(`float3(inputs[${memberOffset}], inputs[${memberOffset + 1}], inputs[${memberOffset + 2}])`);
              memberOffset += 3;
            } else if (mt === 'float4') {
              memberExprs.push(`float4(inputs[${memberOffset}], inputs[${memberOffset + 1}], inputs[${memberOffset + 2}], inputs[${memberOffset + 3}])`);
              memberOffset += 4;
            } else {
              memberExprs.push(`inputs[${memberOffset}]`);
              memberOffset += this.getTypeFlatSize(mt);
            }
          }
          lines.push(`    ${mslType} ${varName} = ${mslType}{${memberExprs.join(', ')}};`);
          return memberOffset;
        }

        // Check for fixed array: array<T, N>
        const arrayMatch = irType.match(/array<([^,]+),\s*(\d+)>/);
        if (arrayMatch) {
          const elemType = arrayMatch[1].trim();
          const len = parseInt(arrayMatch[2]);
          const mslElemType = this.irTypeToMsl(elemType);
          const elemSize = this.getTypeFlatSize(elemType);
          const indices = Array.from({ length: len }, (_, i) => `inputs[${offset + i * elemSize}]`);
          lines.push(`    ${mslElemType} ${varName}[${len}] = {${indices.join(', ')}};`);
          return offset + len * elemSize;
        }

        // Dynamic array: T[]
        const dynMatch = irType.match(/^(.+)\[\]$/);
        if (dynMatch) {
          const elemType = dynMatch[1].trim();
          lines.push(`    int ${varName}_len = int(inputs[${offset}]);`);

          const elemStructDef = this.ir?.structs?.find(s => s.id === elemType);
          if (elemStructDef) {
            // Struct array: declare local array and reconstruct from flat buffer
            const mslType = this.sanitizeId(elemType, 'struct');
            const elemFlatSize = this.getTypeFlatSize(elemType);
            lines.push(`    ${mslType} ${varName}[64];`);
            lines.push(`    for (int _i = 0; _i < ${varName}_len && _i < 64; _i++) {`);
            let memberOff = 0;
            for (const m of elemStructDef.members || []) {
              const mt = m.type;
              const fieldName = this.sanitizeId(m.name, 'field');
              if (mt === 'float') {
                lines.push(`        ${varName}[_i].${fieldName} = inputs[${offset + 1} + _i * ${elemFlatSize} + ${memberOff}];`);
                memberOff += 1;
              } else if (mt === 'int' || mt === 'i32') {
                lines.push(`        ${varName}[_i].${fieldName} = int(inputs[${offset + 1} + _i * ${elemFlatSize} + ${memberOff}]);`);
                memberOff += 1;
              } else if (mt === 'float2') {
                lines.push(`        ${varName}[_i].${fieldName} = float2(inputs[${offset + 1} + _i * ${elemFlatSize} + ${memberOff}], inputs[${offset + 1} + _i * ${elemFlatSize} + ${memberOff + 1}]);`);
                memberOff += 2;
              } else {
                lines.push(`        ${varName}[_i].${fieldName} = inputs[${offset + 1} + _i * ${elemFlatSize} + ${memberOff}];`);
                memberOff += this.getTypeFlatSize(mt);
              }
            }
            lines.push(`    }`);
          } else {
            // Simple type dynamic array: use pointer into flat buffer
            lines.push(`    device float* ${varName} = &inputs[${offset + 1}];`);
          }
          return -1; // Dynamic array consumes the rest
        }

        // Fallback: single float
        lines.push(`    float ${varName} = inputs[${offset}];`);
        return offset + 1;
      }
    }
  }
}
