import { IRDocument, BuiltinOp, TextureFormat, TextureFormatValues, TextureFormatFromId } from '../ir/types';
import { EvaluationContext, RuntimeValue, VectorValue } from './context';

export type OpHandler = (ctx: EvaluationContext, args: Record<string, RuntimeValue>) => RuntimeValue | void;

// Helper for element-wise unary operations
const applyUnary = (val: any, fn: (x: number) => number): any => {
  if (Array.isArray(val)) {
    return (val as number[]).map(fn) as VectorValue;
  }
  return fn(val as number);
};

export const OpRegistry: Record<BuiltinOp, OpHandler> = {
  // ----------------------------------------------------------------
  // Standard Math
  // ----------------------------------------------------------------
  // ----------------------------------------------------------------
  // Standard Math
  // ----------------------------------------------------------------
  'math_add': (ctx, args) => (args.a as number) + (args.b as number),
  'math_sub': (ctx, args) => (args.a as number) - (args.b as number),
  'math_mul': (ctx, args) => (args.a as number) * (args.b as number),
  'math_div': (ctx, args) => (args.a as number) / (args.b as number),
  'math_mad': (ctx, args) => ((args.a as number) * (args.b as number)) + (args.c as number),

  'math_div_scalar': (ctx, args) => {
    const val = args.val as any;
    const scalar = args.scalar as number;
    if (Array.isArray(val)) return val.map(v => v / scalar) as VectorValue;
    return val / scalar;
  },

  // Helpers
  'math_pi': () => Math.PI,
  'math_e': () => Math.E,

  // Unary (Supported for Scalar & Vector)
  'math_sin': (ctx, args) => applyUnary(args.val, Math.sin),
  'math_cos': (ctx, args) => applyUnary(args.val, Math.cos),
  'math_tan': (ctx, args) => applyUnary(args.val, Math.tan),
  'math_sinh': (ctx, args) => applyUnary(args.val, Math.sinh),
  'math_cosh': (ctx, args) => applyUnary(args.val, Math.cosh),
  'math_tanh': (ctx, args) => applyUnary(args.val, Math.tanh),
  'math_asin': (ctx, args) => applyUnary(args.val, Math.asin),
  'math_acos': (ctx, args) => applyUnary(args.val, Math.acos),
  'math_atan': (ctx, args) => applyUnary(args.val, Math.atan),
  'math_exp': (ctx, args) => applyUnary(args.val, Math.exp),
  'math_log': (ctx, args) => applyUnary(args.val, Math.log),
  'math_sqrt': (ctx, args) => applyUnary(args.val, Math.sqrt),
  'math_sign': (ctx, args) => applyUnary(args.val, Math.sign),

  // Existing Unaries refactored to use helper
  'math_ceil': (ctx, args) => applyUnary(args.val, Math.ceil),
  'math_floor': (ctx, args) => applyUnary(args.val, Math.floor),
  'math_abs': (ctx, args) => applyUnary(args.val, Math.abs),

  // Binary
  'math_min': (ctx, args) => Math.min(args.a as number, args.b as number),
  'math_max': (ctx, args) => Math.max(args.a as number, args.b as number),
  'math_pow': (ctx, args) => Math.pow(args.a as number, args.b as number),
  'math_atan2': (ctx, args) => Math.atan2(args.y as number, args.x as number), // Note: args y, x standard

  'math_mod': (ctx, args) => {
    const a = args.a as number;
    const b = args.b as number;
    return a % b;
  },

  'math_clamp': (ctx, args) => {
    const val = args.val as number;
    const min = args.min as number;
    const max = args.max as number;
    return Math.min(Math.max(val, min), max);
  },

  'math_gt': (ctx, args) => (args.a as number) > (args.b as number),
  'math_lt': (ctx, args) => (args.a as number) < (args.b as number),
  'math_ge': (ctx, args) => (args.a as number) >= (args.b as number),
  'math_le': (ctx, args) => (args.a as number) <= (args.b as number),
  'math_eq': (ctx, args) => (args.a as number) === (args.b as number),
  'math_neq': (ctx, args) => (args.a as number) !== (args.b as number),

  // Logic
  'math_and': (ctx, args) => !!(args.a) && !!(args.b),
  'math_or': (ctx, args) => !!(args.a) || !!(args.b),
  'math_xor': (ctx, args) => !!(args.a) !== !!(args.b),
  'math_not': (ctx, args) => !args.val,

  'vec_get_element': (ctx, args) => {
    const vec = args.vec as any;
    const index = args.index as number;
    return vec[index];
  },



  'vec_swizzle': (ctx, args) => {
    const vec = args.vec as number[];
    const channels = args.channels as string; // "x", "xy", "zyx", etc.
    const map: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

    const out = channels.split('').map(c => vec[map[c]]);
    return out.length === 1 ? out[0] : out as VectorValue;
  },

  'vec_dot': (ctx, args) => {
    const a = args.a as number[];
    const b = args.b as number[];
    return a.reduce((sum, v, i) => sum + v * b[i], 0);
  },

  'vec_length': (ctx, args) => {
    const a = args.a as number[];
    const sqSum = a.reduce((sum, v) => sum + v * v, 0);
    return Math.sqrt(sqSum);
  },

  'vec_normalize': (ctx, args) => {
    const a = args.a as number[];
    const len = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    return a.map(v => v / len) as VectorValue;
  },

  'vec_mix': (ctx, args) => {
    const a = args.a as number[];
    const b = args.b as number[];
    const t = args.t as number; // Scalar mix for now
    return a.map((v, i) => v * (1 - t) + b[i] * t) as VectorValue;
  },

  'color_mix': (ctx, args) => {
    // Standard Source-Over Blending
    // dst = background (args.a), src = foreground (args.b)
    const dst = args.a as number[]; // [r, g, b, a]
    const src = args.b as number[]; // [r, g, b, a]

    // Default alpha to 1.0 if missing (e.g. vec3)
    const srcA = src[3] ?? 1.0;
    const dstA = dst[3] ?? 1.0;

    // Alpha Composite: outA = srcA + dstA * (1 - srcA)
    const outA = srcA + dstA * (1.0 - srcA);

    // RGB Composite
    // If outA is 0, result is 0.
    if (outA < 1e-6) return [0, 0, 0, 0];

    const mixCh = (d: number, s: number) =>
      (s * srcA + d * dstA * (1.0 - srcA)) / outA;

    return [
      mixCh(dst[0], src[0]),
      mixCh(dst[1], src[1]),
      mixCh(dst[2], src[2]),
      outA
    ] as VectorValue;
  },

  'vec2': (ctx, args) => {
    return [args.x, args.y] as VectorValue;
  },

  'vec3': (ctx, args) => {
    return [args.x, args.y, args.z] as VectorValue;
  },

  'vec4': (ctx, args) => {
    return [args.x, args.y, args.z, args.w] as VectorValue;
  },

  // ----------------------------------------------------------------
  // Variables & Flow State
  // ----------------------------------------------------------------
  // ----------------------------------------------------------------
  // Variables & Flow State
  // ----------------------------------------------------------------
  'var_set': (ctx, args) => {
    ctx.setVar(args.var as string, args.val);
    return args.val; // Pass-through
  },
  'var_get': (ctx, args) => {
    const val = ctx.getVar(args.var as string);
    if (val === undefined) {
      throw new Error(`Runtime Error: Variable '${args.var}' is not defined (uninitialized)`);
    }
    return val;
  },
  'const_get': (ctx, args) => {
    const name = args.name as string;
    // Registry of Constants
    if (name.startsWith('TextureFormat.')) {
      const key = name.split('.')[1] as keyof typeof TextureFormatValues;
      // Look up in TextureFormatValues if key exists (Note: key should be the Enum Key 'RGBA8', not value 'rgba8')
      // Wait, TextureFormat enum keys are RGBA8, values are 'rgba8'.
      // IR types: TextureFormatValues[TextureFormat.RGBA8] = 1.
      // So if I pass 'TextureFormat.RGBA8', I want 1.
      // How do I lookup?
      // const fmt = TextureFormat[key];
      // if (fmt) return TextureFormatValues[fmt];

      // Simpler: Just map generic names to IDs? Or precise names?
      // Let's support 'TextureFormat.rgba8' (matching enum value) or 'TextureFormat.RGBA8' (matching enum key)?
      // User said "fixed... mapping of string to runtime integer constant".
      // Let's assume input matches the Enum Key for consistency with C++/GPU macros.
      // Actually, my Enum Keys match the upper case names.
      // So 'TextureFormat.RGBA8' -> TextureFormat.RGBA8 ('rgba8') -> TextureFormatValues[...] -> 1

      // Let's try to find it in TextureFormatValues by traversing?
      // Actually TextureFormatValues uses Enum Values as keys.
      // So first map Name (RGBA8) -> Enum Value ('rgba8').

      const enumVal = (TextureFormat as any)[key];
      if (enumVal && typeof enumVal === 'string') {
        return TextureFormatValues[enumVal as TextureFormat];
      }
    }
    return 0;
  },
  'loop_index': (ctx, args) => {
    return ctx.getLoopIndex(args.loop as string);
  },
  'func_return': (ctx, args) => {
    return args.val; // Handled by executor, but returns value here for consistency
  },
  'call_func': (ctx, args) => {
    // Handled by executor directly
  },
  'flow_branch': (ctx, args) => {
    // Handled by executor directly
  },
  'flow_loop': (ctx, args) => {
    // Handled by executor directly
  },

  // ----------------------------------------------------------------
  // Resource Ops
  // ----------------------------------------------------------------
  'resource_get_size': (ctx, args) => {
    const id = args.resource as string;
    const res = ctx.getResource(id);
    return [res.width, res.height] as VectorValue;
  },
  'cmd_resize_resource': (ctx, args) => {
    const id = args.resource as string;
    const sizeVal = args.size;
    const formatArg = args.format; // UnTyped check
    const clearVal = args.clear;

    let newWidth = 1;
    let newHeight = 1;

    if (typeof sizeVal === 'number') {
      newWidth = sizeVal;
    } else if (Array.isArray(sizeVal)) {
      newWidth = sizeVal[0];
      newHeight = sizeVal[1] ?? 1;
    }

    const res = ctx.getResource(id);
    res.width = newWidth;
    res.height = newHeight;

    // Format Handling: Hybrid String/Int
    if (formatArg !== undefined) {
      if (typeof formatArg === 'number') {
        // Int -> String for Def
        const strFmt = TextureFormatFromId[formatArg];
        if (strFmt) res.def.format = strFmt;
      } else if (typeof formatArg === 'string') {
        // String -> String
        res.def.format = formatArg as TextureFormat;
      }
    }

    const totalSize = newWidth * newHeight;

    // Handle Clearing / Resizing Data
    if (clearVal !== undefined) {
      res.data = new Array(totalSize).fill(clearVal); // Re-init
    } else if (res.def.persistence.clearOnResize) {
      const defClear = res.def.persistence.clearValue ?? 0;
      res.data = new Array(totalSize).fill(defClear);
    }

    ctx.logAction('resize', id, { width: newWidth, height: newHeight, format: res.def.format });
  },

  'resource_get_format': (ctx, args) => {
    const id = args.resource as string;
    const res = ctx.getResource(id);
    const fmt = res.def.format ?? TextureFormat.RGBA8; // Returns string enum
    return TextureFormatValues[fmt]; // Returns int ID
  },


  'buffer_store': (ctx, args) => {
    const id = args.buffer as string;
    const idx = args.index as number;
    const val = args.value;
    const res = ctx.getResource(id);

    // Bounds check
    if (idx < 0 || idx >= res.width) return; // OOB Write ignored

    if (!res.data) res.data = [];
    res.data[idx] = val;
  },

  'buffer_load': (ctx, args) => {
    const id = args.buffer as string;
    const idx = args.index as number;
    const res = ctx.getResource(id);

    // Bounds check
    if (idx < 0 || idx >= res.width) return 0; // OOB Read returns 0

    return res.data?.[idx] ?? 0;
  },

  'texture_load': (ctx, args) => {
    // Mock texture read
    return [0, 0, 0, 1];
  },

  'texture_sample': (ctx, args) => {
    const id = args.tex as string;
    const uv = args.uv as [number, number]; // [0..1]
    const res = ctx.getResource(id);

    const wrapMode = res.def.sampler?.wrap || 'clamp';

    const applyWrap = (coord: number): number => {
      if (wrapMode === 'clamp') {
        return Math.max(0, Math.min(1, coord));
      } else if (wrapMode === 'repeat') {
        return coord - Math.floor(coord);
      } else if (wrapMode === 'mirror') {
        const c = coord % 2;
        const m = c < 0 ? c + 2 : c;
        return m > 1 ? 2 - m : m;
      }
      return coord;
    };

    const u = applyWrap(uv[0]);
    const v = applyWrap(uv[1]);

    // Nearest neighbor
    const w = res.width;
    const h = res.height;
    const x = Math.min(Math.floor(u * w), w - 1);
    const y = Math.min(Math.floor(v * h), h - 1);

    const idx = y * w + x;
    return res.data?.[idx] ?? [0, 0, 0, 1];
  },

  'texture_store': (ctx, args) => {
    const id = args.tex as string;
    const coords = args.coords as [number, number];
    const val = args.value;
    const res = ctx.getResource(id);

    if (!res.data) res.data = [];
    if (coords[0] >= res.width || coords[1] >= res.height) return;

    const idx = coords[1] * res.width + coords[0];
    res.data[idx] = val;
  },

  // ----------------------------------------------------------------
  // Dispatch / Draw (Side Effects)
  // ----------------------------------------------------------------
  // ----------------------------------------------------------------
  // Structs & Arrays
  // ----------------------------------------------------------------
  'struct_construct': (ctx, args) => {
    // Return a copy of args as the struct, filtering out metadata
    const out: Record<string, RuntimeValue> = {};
    const ignore = ['op', 'id', 'metadata', 'const_data', 'type'];
    for (const k in args) {
      if (!ignore.includes(k)) {
        out[k] = args[k];
      }
    }
    return out;
  },

  'struct_extract': (ctx, args) => {
    const s = args.struct as Record<string, RuntimeValue>;
    const field = args.field as string;
    if (!s) throw new Error('struct_extract: struct is undefined');
    if (s[field] === undefined) throw new Error(`struct_extract: field '${field}' not found`);
    return s[field];
  },

  'array_construct': (ctx, args) => {
    const len = args.length as number;
    const fill = args.fill ?? 0;
    return new Array(len).fill(fill) as unknown as RuntimeValue;
  },

  'array_extract': (ctx, args) => {
    const arr = args.array as unknown as RuntimeValue[];
    const idx = args.index as number;
    if (!Array.isArray(arr)) throw new Error('array_extract: target is not an array');
    if (idx < 0 || idx >= arr.length) throw new Error(`array_extract: OOB read index ${idx}`);
    return arr[idx];
  },

  'array_set': (ctx, args) => {
    const arr = args.array as unknown as RuntimeValue[];
    const idx = args.index as number;
    const val = args.value;
    if (!Array.isArray(arr)) throw new Error('array_set: target is not an array');
    if (idx < 0 || idx >= arr.length) throw new Error(`array_set: OOB write index ${idx}`);
    arr[idx] = val;
    return val;
  },

  'array_length': (ctx, args) => {
    const arr = args.array as unknown as RuntimeValue[];
    return Array.isArray(arr) ? arr.length : 0;
  },

  'cmd_dispatch': (ctx, args) => {
    // Executor handles Logic, this is just for logging fallback if needed
  },
};
