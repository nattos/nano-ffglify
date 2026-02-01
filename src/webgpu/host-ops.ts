import { BuiltinOp, TextureFormatValues, TextureFormat } from '../ir/types';
import { RuntimeValue, VectorValue, ResourceState } from '../ir/resource-store';
import { OpArgs } from '../ir/builtin-schemas';

export type HostOpHandler<K extends BuiltinOp> = (args: OpArgs[K]) => RuntimeValue | void;

// Helper for element-wise unary operations
const applyUnary = (val: any, fn: (x: number) => number): any => {
  if (Array.isArray(val)) {
    return (val as number[]).map(fn) as VectorValue;
  }
  if (typeof val !== 'number') return 0; // Guard
  return fn(val as number);
};

// Helper for element-wise binary operations
const applyBinary = (a: any, b: any, op: (x: number, y: number) => number): any => {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = op(a[i], b[i]);
    return out;
  }
  // Broadcasting: Scalar op Vector
  if (typeof a === 'number' && Array.isArray(b)) {
    return b.map(v => op(a, v));
  }
  if (Array.isArray(a) && typeof b === 'number') {
    return a.map(v => op(v, b));
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return op(a, b);
  }
  return 0;
};

// Helper for comparison/logic
const applyComparison = (a: any, b: any, op: (x: number, y: number) => boolean): any => {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = op(a[i], b[i]) ? 1.0 : 0.0;
    return out;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return op(a, b);
  }
  return false;
};

export const HostOps: { [K in BuiltinOp]?: HostOpHandler<K> } = {
  'math_add': (args) => applyBinary(args.a, args.b, (a, b) => a + b),
  'math_sub': (args) => applyBinary(args.a, args.b, (a, b) => a - b),
  'math_mul': (args) => applyBinary(args.a, args.b, (a, b) => a * b),
  'math_div': (args) => applyBinary(args.a, args.b, (a, b) => a / b),
  'math_mod': (args) => applyBinary(args.a, args.b, (a, b) => a % b),
  'math_mad': (args) => {
    const A = args.a, B = args.b, C = args.c;
    if (Array.isArray(A) && Array.isArray(B) && Array.isArray(C)) {
      return A.map((v, i) => v * B[i] + C[i]);
    }
    return (A as number * B as number) + (C as number);
  },
  'math_sin': (args) => applyUnary(args.val, Math.sin),
  'math_cos': (args) => applyUnary(args.val, Math.cos),
  'math_tan': (args) => applyUnary(args.val, Math.tan),
  'math_asin': (args) => applyUnary(args.val, Math.asin),
  'math_acos': (args) => applyUnary(args.val, Math.acos),
  'math_atan': (args) => applyUnary(args.val, Math.atan),
  'math_atan2': (args) => applyBinary(args.a, args.b, Math.atan2),
  'math_sinh': (args) => applyUnary(args.val, Math.sinh),
  'math_cosh': (args) => applyUnary(args.val, Math.cosh),
  'math_tanh': (args) => applyUnary(args.val, Math.tanh),
  'math_asinh': (args) => applyUnary(args.val, Math.asinh),
  'math_acosh': (args) => applyUnary(args.val, Math.acosh),
  'math_atanh': (args) => applyUnary(args.val, Math.atanh),
  'math_abs': (args) => applyUnary(args.val, Math.abs),
  'math_floor': (args) => applyUnary(args.val, Math.floor),
  'math_ceil': (args) => applyUnary(args.val, Math.ceil),
  'math_round': (args) => applyUnary(args.val, Math.round),
  'math_trunc': (args) => applyUnary(args.val, Math.trunc),
  'math_sign': (args) => applyUnary(args.val, Math.sign),
  'math_fract': (args) => applyUnary(args.val, (x) => x - Math.floor(x)),
  'math_sqrt': (args) => applyUnary(args.val, Math.sqrt),
  'math_exp': (args) => applyUnary(args.val, Math.exp),
  'math_log': (args) => applyUnary(args.val, Math.log),
  'math_pow': (args) => applyBinary(args.a, args.b, Math.pow),
  'math_min': (args) => applyBinary(args.a, args.b, Math.min),
  'math_max': (args) => applyBinary(args.a, args.b, Math.max),
  'math_clamp': (args) => {
    const { val, min, max } = args;
    if (Array.isArray(val) && Array.isArray(min) && Array.isArray(max)) {
      return val.map((v, i) => Math.min(Math.max(v, min[i]), max[i]));
    }
    if (Array.isArray(val) && typeof min === 'number' && typeof max === 'number') {
      return val.map(v => Math.min(Math.max(v, min), max));
    }
    return Math.min(Math.max(val as number, min as number), max as number);
  },
  'math_step': (args) => applyBinary(args.edge, args.x, (edge, x) => (x < edge ? 0 : 1)),
  'math_smoothstep': (args) => {
    const { edge0, edge1, x } = args;
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  },
  'math_mix': (args) => {
    const { a, b, t } = args;
    return applyBinary(applyBinary(a, 1 - t, (x, y) => x * y), applyBinary(b, t, (x, y) => x * y), (x, y) => x + y);
  },
  'math_is_inf': (args) => applyUnary(args.val, (x) => (Math.abs(x) === Infinity ? 1 : 0)),
  'math_is_nan': (args) => applyUnary(args.val, (x) => (isNaN(x) ? 1 : 0)),
  'math_is_finite': (args) => applyUnary(args.val, (x) => (isFinite(x) ? 1 : 0)),
  'math_flush_subnormal': (args) => applyUnary(args.val, (x) => (Math.abs(x) < 1.17549435e-38 ? 0 : x)),
  'math_frexp_mantissa': (args) => {
    const val = args.val as number;
    if (val === 0) return 0;
    const exponent = Math.floor(Math.log2(Math.abs(val))) + 1;
    return val / Math.pow(2, exponent);
  },
  'math_mantissa': (args) => {
    const val = args.val as number;
    if (val === 0) return 0;
    const exponent = Math.floor(Math.log2(Math.abs(val))) + 1;
    return val / Math.pow(2, exponent);
  },
  'math_frexp_exponent': (args) => {
    const val = args.val as number;
    if (val === 0) return 0;
    return Math.floor(Math.log2(Math.abs(val))) + 1;
  },
  'math_exponent': (args) => {
    const val = args.val as number;
    if (val === 0) return 0;
    return Math.floor(Math.log2(Math.abs(val))) + 1;
  },
  'math_ldexp': (args) => {
    const { val, exp } = args;
    return (val as number) * Math.pow(2, exp as number);
  },
  'math_pi': () => Math.PI,
  'math_e': () => Math.E,

  'math_gt': (args) => applyComparison(args.a, args.b, (a, b) => a > b),
  'math_lt': (args) => applyComparison(args.a, args.b, (a, b) => a < b),
  'math_ge': (args) => applyComparison(args.a, args.b, (a, b) => a >= b),
  'math_le': (args) => applyComparison(args.a, args.b, (a, b) => a <= b),
  'math_eq': (args) => applyComparison(args.a, args.b, (a, b) => a === b),
  'math_neq': (args) => applyComparison(args.a, args.b, (a, b) => a !== b),

  'vec_dot': (args) => {
    const a = args.a as number[], b = args.b as number[];
    return a.reduce((sum, v, i) => sum + v * b[i], 0);
  },
  'vec_length': (args) => {
    const a = args.a as number[];
    return Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  },
  'vec_normalize': (args) => {
    const a = args.a as number[];
    const len = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    if (len < 1e-10) return a.map(() => 0);
    return a.map(v => v / len);
  },
  'vec_mix': (args) => {
    const { a, b, t } = args;
    if (typeof t === 'boolean') return t ? b : a;
    if (Array.isArray(t)) return a.map((v: number, i: number) => v * (1 - t[i]) + b[i] * t[i]);
    if (Array.isArray(a)) return a.map((v: number, i: number) => v * (1 - t) + b[i] * t);
    return a * (1 - t) + b * t;
  },
  'vec_swizzle': (args) => {
    const vec = args.vec as number[];
    const channels = args.channels as string;
    const map: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
    const out = channels.split('').map(c => vec[map[c]]);
    return out.length === 1 ? out[0] : out;
  },

  'float2': (args) => [args.x, args.y],
  'float3': (args) => [args.x, args.y, args.z],
  'float4': (args) => [args.x, args.y, args.z, args.w],
  'float3x3': (args) => args.vals || [0, 0, 0, 0, 0, 0, 0, 0, 0],
  'float4x4': (args) => args.vals || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],

  'mat_mul': (args) => {
    const a = args.a as number[], b = args.b as number[];
    const dim = a.length === 16 ? 4 : 3;

    if (b.length === a.length) {
      const out = new Array(dim * dim);
      for (let r = 0; r < dim; r++) {
        for (let c = 0; c < dim; c++) {
          let sum = 0;
          for (let k = 0; k < dim; k++) sum += a[k * dim + r] * b[c * dim + k];
          out[c * dim + r] = sum;
        }
      }
      return out;
    }
    if (b.length === dim) {
      const out = new Array(dim).fill(0);
      for (let r = 0; r < dim; r++) {
        let sum = 0;
        for (let c = 0; c < dim; c++) sum += a[c * dim + r] * b[c];
        out[r] = sum;
      }
      return out;
    }
    return 0;
  },

  'const_get': (args) => {
    const name = args.name as string;
    if (name.startsWith('TextureFormat.')) {
      const key = name.split('.')[1] as keyof typeof TextureFormatValues;
      const enumVal = (TextureFormat as any)[key];
      if (enumVal) return TextureFormatValues[enumVal as TextureFormat];
    }
    return 0;
  },
  'float': (args) => args.val,
  'int': (args) => args.val,
  'bool': (args) => args.val,
  'uint': (args) => args.val,
  'static_cast_float': (args) => Number(args.val),
  'static_cast_int': (args) => Math.floor(Number(args.val)),
  'static_cast_bool': (args) => Boolean(args.val),
  'static_cast_uint': (args) => Math.max(0, Math.floor(Number(args.val))),

  'struct_construct': (args) => {
    const out: any = {};
    const ignore = ['op', 'id', 'metadata', 'const_data', 'type'];
    for (const k in args) if (!ignore.includes(k)) out[k] = args[k];
    return out;
  },
  'struct_extract': (args) => {
    if (!args.struct) return 0;
    return args.struct[args.field];
  },
  'array_construct': (args) => {
    if (args.values) return [...args.values];
    return new Array(args.length || 0).fill(args.fill ?? 0);
  },
  'array_extract': (args) => {
    if (!args.array) return 0;
    return args.array[args.index];
  },
  'array_set': (args) => {
    if (!args.array) return 0;
    args.array[args.index] = args.value;
    return args.value;
  },
  'mat_extract': (args) => {
    if (!args.mat) return 0;
    const dim = args.mat.length === 16 ? 4 : 3;
    return args.mat[args.col * dim + args.row];
  }
};
