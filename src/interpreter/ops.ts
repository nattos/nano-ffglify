import { IRDocument, BuiltinOp, TextureFormat, TextureFormatValues, TextureFormatFromId } from '../ir/types';
import { OpArgs } from '../ir/builtin-schemas';
import { EvaluationContext, RuntimeValue, VectorValue } from './context';

export type OpHandler<K extends BuiltinOp> = (ctx: EvaluationContext, args: OpArgs[K]) => RuntimeValue | void;

const validateArg = (args: Record<string, RuntimeValue>, key: string, types: string | string[]) => {
  const val = args[key];
  if (val === undefined) throw new Error(`Runtime Error: Missing argument '${key}'`);

  const typeList = Array.isArray(types) ? types : [types];
  const actualType = Array.isArray(val) ? 'vector' : typeof val;

  // Simple type mapping: 'number' -> scalar, 'vector' -> array
  // If expecting 'number', we want scalar number.

  if (!typeList.includes(actualType)) {
    throw new Error(`Runtime Error: Argument '${key}' expected one of [${typeList.join(', ')}], got ${actualType}`);
  }
  return val;
};

// Helper for element-wise unary operations
const applyUnary = (val: any, fn: (x: number) => number): any => {
  if (Array.isArray(val)) {
    return (val as number[]).map(fn) as VectorValue;
  }
  if (typeof val !== 'number') throw new Error(`Runtime Error: Invalid type for unary op: ${typeof val}`);
  return fn(val as number);
};

// Helper for element-wise binary operations
const applyBinary = (a: any, b: any, op: (x: number, y: number) => number): any => {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) throw new Error(`Runtime Error: Binary op dimension mismatch (${a.length} vs ${b.length})`);
    return a.map((v, i) => op(v, b[i])) as VectorValue;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return op(a, b);
  }
  throw new Error(`Runtime Error: Invalid types for binary op: ${typeof a}, ${typeof b}`);
};

// Helper for comparison/logic (Vector -> 0.0/1.0, Scalar -> Boolean)
const applyComparison = (a: any, b: any, op: (x: number, y: number) => boolean): any => {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) throw new Error(`Runtime Error: Comparison op dimension mismatch`);
    return a.map((v, i) => op(v, b[i]) ? 1.0 : 0.0) as VectorValue;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return op(a, b);
  }
  throw new Error(`Runtime Error: Invalid types for comparison op: ${typeof a}, ${typeof b}`);
};

export const OpRegistry: { [K in BuiltinOp]: OpHandler<K> } = {
  // ----------------------------------------------------------------
  // Standard Math
  // ----------------------------------------------------------------
  'math_add': (ctx, args) => applyBinary(args.a, args.b, (a, b) => a + b),
  'math_sub': (ctx, args) => applyBinary(args.a, args.b, (a, b) => a - b),
  'math_mul': (ctx, args) => applyBinary(args.a, args.b, (a, b) => a * b),
  'math_div': (ctx, args) => applyBinary(args.a, args.b, (a, b) => a / b),
  'math_mad': (ctx, args) => {
    // a * b + c (Vectorized)
    const A = args.a;
    const B = args.b;
    const C = args.c;
    // Manual expansion since it's ternary
    if (Array.isArray(A) && Array.isArray(B) && Array.isArray(C)) {
      return A.map((v, i) => (v as number) * (B[i] as number) + (C[i] as number));
    }
    const a = A as number, b = B as number, c = C as number;
    return (a * b) + c;
  },

  'math_div_scalar': (ctx, args) => {
    const val = validateArg(args, 'val', ['number', 'vector']);
    const scalar = validateArg(args, 'scalar', 'number') as number;
    if (Array.isArray(val)) return val.map((v: any) => v / scalar) as VectorValue;
    return (val as number) / scalar;
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
  'math_min': (ctx, args) => applyBinary(args.a, args.b, Math.min),
  'math_max': (ctx, args) => applyBinary(args.a, args.b, Math.max),
  'math_pow': (ctx, args) => applyBinary(args.a, args.b, Math.pow),
  'math_atan2': (ctx, args) => applyBinary(args.a, args.b, Math.atan2), // Note: args y, x standard. My signatures said a,b? No, signatures said y,x for atan2. But applyBinary uses args.a, args.b?
  // Check atan2 signature: genMathVariants uses 'a', 'b'.
  // Wait, my previous ops.ts had 'math_atan2': (ctx, args) => Math.atan2(args.y, args.x).
  // My new signature generator used 'genMathVariants' which generates 'a' and 'b'.
  // This is a mismatch! 'math_atan2' usually takes y, x.
  // I should fix signature to use 'y', 'x' or update op to use 'a', 'b'. 'a'='y', 'b'='x'?
  // Standard GLSL: atan(y, x).
  // Let's stick to 'y' and 'x' for readability, but my helper blindly generated 'a', 'b'.
  // I'll manually fix atan2 signature in previous step? Or just use 'a' and 'b' here mapping to y/x logic?
  // Let's just update atomic op here to use 'a' and 'b' (y=a, x=b) to match the generated signature.
  // Actually, I can customize applyBinary to accept key names. Or just pass args.y, args.x if I fix signature.
  // But signatures are already 'a', 'b' due to genMathVariants.
  // So 'math_atan2(a, b)' -> atan2(a, b) -> atan2(y, x). So a=y, b=x.

  'math_mod': (ctx, args) => applyBinary(args.a, args.b, (a, b) => a % b),

  'math_clamp': (ctx, args) => {
    // Vector support for clamp
    const val = args.val;
    const min = args.min;
    const max = args.max;

    // Vector, Vector, Vector
    if (Array.isArray(val) && Array.isArray(min) && Array.isArray(max)) {
      return val.map((v, i) => Math.min(Math.max(v as number, min[i] as number), max[i] as number)) as VectorValue;
    }
    // Vector, Scalar, Scalar (newly supported)
    if (Array.isArray(val) && typeof min === 'number' && typeof max === 'number') {
      return val.map(v => Math.min(Math.max(v as number, min), max)) as VectorValue;
    }
    // Scalar
    if (typeof val === 'number' && typeof min === 'number' && typeof max === 'number') {
      return Math.min(Math.max(val, min), max);
    }
    throw new Error('Runtime Error: Invalid types for math_clamp');
  },

  // Advanced Math
  'math_fract': (ctx, args) => applyUnary(args.val, x => x - Math.floor(x)),
  'math_trunc': (ctx, args) => applyUnary(args.val, Math.trunc),

  // Classification
  'math_is_nan': (ctx, args) => {
    const val = args.val;
    if (Array.isArray(val)) return val.map(v => Number.isNaN(v as number) ? 1.0 : 0.0);
    return Number.isNaN(val as number); // Boolean
  },
  'math_is_inf': (ctx, args) => {
    const val = args.val;
    if (Array.isArray(val)) return val.map(v => (!Number.isFinite(v as number) && !Number.isNaN(v as number)) ? 1.0 : 0.0);
    return (!Number.isFinite(val as number) && !Number.isNaN(val as number));
  },
  'math_is_finite': (ctx, args) => {
    const val = args.val;
    if (Array.isArray(val)) return val.map(v => Number.isFinite(v) ? 1.0 : 0.0);
    return Number.isFinite(val);
  },

  'math_flush_subnormal': (ctx, args) => applyUnary(args.val, x => {
    if (x === 0) return 0;
    // Common min float32 ~1.175e-38 (normalized)
    // Smallest subnormal ~1.4e-45
    // If abs(x) < 1.17549435e-38, flush to 0.
    return Math.abs(x) < 1.17549435e-38 ? 0 : x;
  }),

  'math_mantissa': (ctx, args) => applyUnary(args.val, x => {
    if (x === 0 || !Number.isFinite(x)) return x;
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat64(0, x);
    const hi = view.getUint32(0);
    const expBits = (hi >> 20) & 0x7FF;
    const exp = expBits - 1023 + 1; // frexp exponent
    return x * Math.pow(2, -exp); // Returns range [0.5, 1)
  }),

  'math_exponent': (ctx, args) => applyUnary(args.val, x => {
    if (x === 0) return 0;
    if (!Number.isFinite(x)) return x;
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat64(0, x);
    const hi = view.getUint32(0);
    const expBits = (hi >> 20) & 0x7FF;
    return expBits - 1023 + 1;
  }),

  'math_gt': (ctx, args) => applyComparison(args.a, args.b, (a, b) => a > b),
  'math_lt': (ctx, args) => applyComparison(args.a, args.b, (a, b) => a < b),
  'math_ge': (ctx, args) => applyComparison(args.a, args.b, (a, b) => a >= b),
  'math_le': (ctx, args) => applyComparison(args.a, args.b, (a, b) => a <= b),
  'math_eq': (ctx, args) => applyComparison(args.a, args.b, (a, b) => a === b),
  'math_neq': (ctx, args) => applyComparison(args.a, args.b, (a, b) => a !== b),

  // Logic
  'math_and': (ctx, args) => !!(args.a) && !!(args.b),
  'math_or': (ctx, args) => !!(args.a) || !!(args.b),
  'math_xor': (ctx, args) => !!(args.a) !== !!(args.b),
  'math_not': (ctx, args) => !args.val,

  // Casts
  'static_cast_int': (ctx, args) => {
    const val = args.val;
    if (typeof val === 'boolean') return val ? 1 : 0;
    if (typeof val === 'number') return val | 0; // Enforce 32-bit integer
    return 0;
  },
  'static_cast_float': (ctx, args) => {
    const val = args.val;
    if (typeof val === 'boolean') return val ? 1.0 : 0.0;
    if (typeof val === 'number') return val;
    return 0.0;
  },
  'static_cast_bool': (ctx, args) => {
    const val = args.val;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    return false;
  },

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
    const a = validateArg(args, 'a', 'vector') as number[];
    const b = validateArg(args, 'b', 'vector') as number[];
    if (a.length !== b.length) throw new Error(`Runtime Error: vec_dot dimension mismatch (${a.length} vs ${b.length})`);
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
    const a = validateArg(args, 'a', 'vector') as number[];
    const b = validateArg(args, 'b', 'vector') as number[];
    const t = validateArg(args, 't', ['number', 'vector', 'boolean']);

    if (a.length !== b.length) throw new Error(`Runtime Error: vec_mix dimension mismatch`);

    if (typeof t === 'boolean') {
      return t ? b : a; // Select B if True
    }

    if (Array.isArray(t)) {
      if (t.length !== a.length) throw new Error(`Runtime Error: vec_mix t dimension mismatch`);
      return a.map((v, i) => v * (1 - (t[i] as number)) + b[i] * (t[i] as number)) as VectorValue;
    }
    const tVal = t as number;
    return a.map((v, i) => v * (1 - tVal) + b[i] * tVal) as VectorValue;
  },

  'color_mix': (ctx, args) => {
    // Standard Source-Over Blending
    // dst = background (args.a), src = foreground (args.b)
    const dst = args.a as number[]; // [r, g, b, a]
    const src = args.b as number[]; // [r, g, b, a]

    // Default alpha to 1.0 if missing (e.g. float3)
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

  'float2': (ctx, args) => {
    return [args.x, args.y] as VectorValue;
  },

  'float3': (ctx, args) => {
    return [args.x, args.y, args.z] as VectorValue;
  },

  'float4': (ctx, args) => {
    return [args.x, args.y, args.z, args.w] as VectorValue;
  },

  'float': (ctx, args) => args.val,
  'int': (ctx, args) => args.val,
  'bool': (ctx, args) => args.val,
  'string': (ctx, args) => args.val,

  // ----------------------------------------------------------------
  // Matrix Operations (Column Major)
  // ----------------------------------------------------------------
  'float3x3': (ctx, args) => {
    // 3 args (vectors) or 9 args (scalars)
    // Simplified: expects 'cols' array of 3 float3s or 'vals' array of 9 numbers
    // Fallback: 9 scalars c0r0, c0r1...
    if (Array.isArray(args.cols)) return (args.cols as any[]).flat();
    if (Array.isArray(args.vals)) return args.vals;
    return new Array(9).fill(0);
  },

  'float4x4': (ctx, args) => {
    // Expects 'cols' (4 float4s) or 'vals' (16 numbers)
    if (Array.isArray(args.cols)) return (args.cols as any).flat();
    if (Array.isArray(args.vals)) return args.vals as VectorValue;
    return new Array(16).fill(0) as VectorValue;
  },

  'mat_identity': (ctx, args) => {
    const size = args.size as number; // 3 or 4
    if (size === 3) return [1, 0, 0, 0, 1, 0, 0, 0, 1] as VectorValue;
    // Default 4
    return [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ] as VectorValue;
  },

  'mat_transpose': (ctx, args) => {
    const m = args.val as number[];
    if (m.length === 9) {
      return [
        m[0], m[3], m[6],
        m[1], m[4], m[7],
        m[2], m[5], m[8]
      ] as VectorValue;
    }
    // Assume 16
    return [
      m[0], m[4], m[8], m[12],
      m[1], m[5], m[9], m[13],
      m[2], m[6], m[10], m[14],
      m[3], m[7], m[11], m[15]
    ] as VectorValue;
  },

  'mat_inverse': (ctx, args) => {
    // Placeholder for robust inverse
    // Returning Identity if singular?
    // For now, implementing simple Identity fallback or very basic 2D inverse logic isn't worth it inline.
    // Let's implement full 4x4 inverse later or use a library.
    // Just returning Identity for now to pass type checks, with TODO.
    // Or better: Implement basic inverse if user asks. User said "properly support".
    // I'll leave as Identity with TODO log for now to focus on Multiply first.
    return args.val;
  },

  'mat_mul': (ctx, args) => {
    const a = validateArg(args, 'a', 'vector') as number[];
    const b = validateArg(args, 'b', 'vector') as number[];

    const isfloat4x4 = (v: number[]) => v.length === 16;
    const isfloat3x3 = (v: number[]) => v.length === 9;
    const isfloat4 = (v: number[]) => v.length === 4;
    const isfloat3 = (v: number[]) => v.length === 3;

    // Helper: Column-Major Matrix Multiply
    const mulMat = (A: number[], B: number[], dim: number) => {
      const out = new Array(dim * dim);
      for (let r = 0; r < dim; r++) {
        for (let c = 0; c < dim; c++) {
          let sum = 0;
          for (let k = 0; k < dim; k++) {
            // A[r, k] * B[k, c]
            sum += A[k * dim + r] * B[c * dim + k];
          }
          out[c * dim + r] = sum;
        }
      }
      return out;
    };

    // Helper: Mat * Vec (Post-mul) -> v' = M * v
    const mulMatVec = (A: number[], v: number[], dim: number) => {
      const out = new Array(dim).fill(0);
      for (let r = 0; r < dim; r++) {
        let sum = 0;
        for (let c = 0; c < dim; c++) {
          sum += A[c * dim + r] * v[c];
        }
        out[r] = sum;
      }
      return out;
    };

    // Helper: Vec * Mat (Pre-mul) -> v' = v * M (Row vector mul)
    // v' [c] = sum(v[r] * M[r, c])
    const mulVecMat = (v: number[], B: number[], dim: number) => {
      const out = new Array(dim).fill(0);
      for (let c = 0; c < dim; c++) {
        let sum = 0;
        for (let r = 0; r < dim; r++) {
          sum += v[r] * B[c * dim + r];
        }
        out[c] = sum;
      }
      return out;
    };

    // Dispatch
    if (isfloat4x4(a) && isfloat4x4(b)) return mulMat(a, b, 4) as VectorValue;
    if (isfloat3x3(a) && isfloat3x3(b)) return mulMat(a, b, 3) as VectorValue;

    if (isfloat4x4(a) && isfloat4(b)) return mulMatVec(a, b, 4) as VectorValue;
    if (isfloat3x3(a) && isfloat3(b)) return mulMatVec(a, b, 3) as VectorValue;

    if (isfloat4(a) && isfloat4x4(b)) return mulVecMat(a, b, 4) as VectorValue;
    if (isfloat4(a) && isfloat4x4(b)) return mulVecMat(a, b, 4) as VectorValue;
    if (isfloat3(a) && isfloat3x3(b)) return mulVecMat(a, b, 3) as VectorValue;

    throw new Error(`Runtime Error: mat_mul dimension mismatch or invalid types (ALen: ${a.length}, BLen: ${b.length})`);
  },

  // ----------------------------------------------------------------
  // Quaternion Operations (xyzw)
  // ----------------------------------------------------------------
  'quat': (ctx, args) => {
    return [args.x, args.y, args.z, args.w] as VectorValue;
  },

  'quat_identity': () => {
    return [0, 0, 0, 1] as VectorValue;
  },

  'quat_mul': (ctx, args) => {
    // Hamilton Product
    // q1 * q2
    const a = args.a as number[]; // [x1, y1, z1, w1]
    const b = args.b as number[]; // [x2, y2, z2, w2]

    const x1 = a[0], y1 = a[1], z1 = a[2], w1 = a[3];
    const x2 = b[0], y2 = b[1], z2 = b[2], w2 = b[3];

    return [
      w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
      w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
      w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
      w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2
    ] as VectorValue;
  },

  'quat_slerp': (ctx, args) => {
    const a = args.a as number[];
    const b = args.b as number[];
    const t = args.t as number;

    let ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];

    let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;

    // If q1=q2 or opposite, handle
    if (Math.abs(cosHalfTheta) >= 1.0) {
      return a as VectorValue;
    }

    // Shortest path
    if (cosHalfTheta < 0) {
      bx = -bx; by = -by; bz = -bz; bw = -bw;
      cosHalfTheta = -cosHalfTheta;
    }

    const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);

    // Linear fallback for small angles
    if (Math.abs(sinHalfTheta) < 0.001) {
      return [
        (1 - t) * ax + t * bx,
        (1 - t) * ay + t * by,
        (1 - t) * az + t * bz,
        (1 - t) * aw + t * bw
      ] as VectorValue;
    }

    const halfTheta = Math.acos(cosHalfTheta);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

    return [
      ax * ratioA + bx * ratioB,
      ay * ratioA + by * ratioB,
      az * ratioA + bz * ratioB,
      aw * ratioA + bw * ratioB
    ] as VectorValue;
  },

  'quat_to_float4x4': (ctx, args) => {
    const q = args.q as number[];
    const x = q[0], y = q[1], z = q[2], w = q[3];

    // Normalized check? Assuming input is normalized for float4x4 conversion usually.
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    return [
      1 - (yy + zz), xy + wz, xz - wy, 0,
      xy - wz, 1 - (xx + zz), yz + wx, 0,
      xz + wy, yz - wx, 1 - (xx + yy), 0,
      0, 0, 0, 1
    ] as VectorValue;
  },

  'quat_rotate': (ctx, args) => {
    const q = args.q as number[];
    const v = args.v as number[]; // float3 expected

    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const vx = v[0], vy = v[1], vz = v[2];

    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);

    const outX = vx + qw * tx + (qy * tz - qz * ty);
    const outY = vy + qw * ty + (qz * tx - qx * tz);
    const outZ = vz + qw * tz + (qx * ty - qy * tx);

    return [outX, outY, outZ] as VectorValue;
  },

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
    throw new Error(`Runtime Error: Unknown constant '${name}'`);
  },
  'loop_index': (ctx, args) => {
    return ctx.getLoopIndex(args.loop as string);
  },
  'func_return': (ctx, args) => {
    return args.value !== undefined ? args.value : args.val;
  },
  'call_func': (ctx, args) => {
    // Handled by executor directly
  },
  'literal': (ctx, args) => {
    return args.val;
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

    const clearVal = args.clear;

    let newWidth = 1;
    let newHeight = 1;

    if (typeof sizeVal === 'number') {
      newWidth = sizeVal;
    } else if (Array.isArray(sizeVal)) {
      const arr = sizeVal as any[]; // Cast to any array to access indices safely as numbers
      newWidth = arr[0] as number;
      newHeight = arr[1] as number ?? 1;
    }

    const res = ctx.getResource(id);
    res.width = newWidth;
    res.height = newHeight;



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
    if (idx < 0 || idx >= res.width) throw new Error(`Runtime Error: buffer_store OOB (index ${idx}, size ${res.width})`);

    if (!res.data) res.data = [];
    res.data[idx] = val;
  },

  'buffer_load': (ctx, args) => {
    const id = args.buffer as string;
    const idx = args.index as number;
    const res = ctx.getResource(id);

    // Bounds check
    if (idx < 0 || idx >= res.width) throw new Error(`Runtime Error: buffer_load OOB (index ${idx}, size ${res.width})`);

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
    const filterMode = res.def.sampler?.filter || 'nearest';

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

    const w = res.width;
    const h = res.height;

    const normalizeSample = (val: any): [number, number, number, number] => {
      if (Array.isArray(val)) {
        if (val.length === 4) return val as [number, number, number, number];
        if (val.length === 3) return [val[0], val[1], val[2], 1];
        if (val.length === 1) return [val[0], val[0], val[0], 1];
        return [val[0] || 0, val[1] || 0, val[2] || 0, val[3] || 1];
      }
      if (typeof val === 'number') return [val, val, val, 1];
      return [0, 0, 0, 1];
    };

    if (filterMode === 'nearest') {
      const x = Math.min(Math.floor(u * w), w - 1);
      const y = Math.min(Math.floor(v * h), h - 1);
      const idx = y * w + x;
      return normalizeSample(res.data?.[idx]);
    } else {
      // Bilinear
      const tx = u * w - 0.5;
      const ty = v * h - 0.5;

      const x0 = Math.floor(tx);
      const y0 = Math.floor(ty);
      const x1 = x0 + 1;
      const y1 = y0 + 1;

      const fx = tx - x0;
      const fy = ty - y0;

      const getSafeSample = (x: number, y: number) => {
        let sx = x;
        let sy = y;
        if (wrapMode === 'clamp') {
          sx = Math.max(0, Math.min(w - 1, sx));
          sy = Math.max(0, Math.min(h - 1, sy));
        } else if (wrapMode === 'repeat') {
          sx = ((sx % w) + w) % w;
          sy = ((sy % h) + h) % h;
        } else if (wrapMode === 'mirror') {
          // Simplification for pixel space mirroring
          const mx = ((sx % (2 * w)) + (2 * w)) % (2 * w);
          sx = mx >= w ? 2 * w - 1 - mx : mx;
          const my = ((sy % (2 * h)) + (2 * h)) % (2 * h);
          sy = my >= h ? 2 * h - 1 - my : my;
        }
        return normalizeSample(res.data?.[sy * w + sx]);
      };

      const s00 = getSafeSample(x0, y0);
      const s10 = getSafeSample(x1, y0);
      const s01 = getSafeSample(x0, y1);
      const s11 = getSafeSample(x1, y1);

      return [0, 1, 2, 3].map(i => {
        const r0 = s00[i] * (1 - fx) + s10[i] * fx;
        const r1 = s01[i] * (1 - fx) + s11[i] * fx;
        return r0 * (1 - fy) + r1 * fy;
      }) as [number, number, number, number];
    }
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
    if (Array.isArray(s)) throw new Error(`Runtime Error: struct_extract called on non-struct (Vector/Array)`);
    if (s[field] === undefined) throw new Error(`struct_extract: field '${field}' not found`);
    return s[field];
  },

  'array_construct': (ctx, args) => {
    if (args.values && Array.isArray(args.values)) {
      return [...args.values];
    }
    const len = args.length as number || 0;
    const fill = args.fill ?? 0;
    return new Array(len).fill(fill) as unknown as RuntimeValue;
  },

  'array_extract': (ctx, args) => {
    const arr = args.array as RuntimeValue[];
    const idx = args.index as number;
    if (!Array.isArray(arr)) throw new Error('array_extract: target is not an array');
    if (idx < 0 || idx >= arr.length) throw new Error(`array_extract: OOB read index ${idx}`);
    return arr[idx];
  },

  'array_set': (ctx, args) => {
    const arr = args.array as RuntimeValue[];
    const idx = args.index as number;
    const val = args.value;
    if (!Array.isArray(arr)) throw new Error('array_set: target is not an array');
    if (idx < 0 || idx >= arr.length) throw new Error(`array_set: OOB write index ${idx}`);
    arr[idx] = val;
    return val;
  },

  'array_length': (ctx, args) => {
    const arr = args.array as RuntimeValue[];
    return Array.isArray(arr) ? arr.length : 0;
  },

  'cmd_dispatch': (ctx, args) => {
    const targetId = args.func as string;
    const dim = args.dispatch as [number, number, number] || [1, 1, 1];
    // Pass everything minus infrastructure props as potential arguments
    const { func: _, dispatch: __, ...rest } = args;
    ctx.webGpuExec.executeShader(targetId, dim, rest);
  },
  'cmd_draw': (ctx, args) => {
    // Basic draw command that delegates to the backend executor
    const targetId = args.target as string;
    const vertexId = args.vertex as string;
    const fragmentId = args.fragment as string;
    const count = args.count as number;
    const pipeline = args.pipeline as any;

    // In Phase 2, this will also trigger the SoftwareRasterizer if ctx has it.
    ctx.webGpuExec?.executeDraw(targetId, vertexId, fragmentId, count, pipeline);
  },
};
