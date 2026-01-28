import { EvaluationContext, RuntimeValue, VectorValue } from './context';

export type OpHandler = (ctx: EvaluationContext, args: Record<string, RuntimeValue>) => RuntimeValue | void;

export const OpRegistry: Record<string, OpHandler> = {
  // ----------------------------------------------------------------
  // Standard Math
  // ----------------------------------------------------------------
  'math_add': (ctx, args) => (args.a as number) + (args.b as number),
  'math_sub': (ctx, args) => (args.a as number) - (args.b as number),
  'math_mul': (ctx, args) => (args.a as number) * (args.b as number),
  'math_div': (ctx, args) => (args.a as number) / (args.b as number),
  'math_mad': (ctx, args) => ((args.a as number) * (args.b as number)) + (args.c as number),

  'math_div_scalar': (ctx, args) => {
    // Handling vec2 / scalar
    const val = args.val as any;
    const scalar = args.scalar as number;
    if (Array.isArray(val)) {
      return val.map(v => v / scalar) as VectorValue;
    }
    return val / scalar;
  },

  'math_ceil': (ctx, args) => {
    const val = args.val as any;
    if (Array.isArray(val)) return val.map(Math.ceil) as VectorValue;
    return Math.ceil(val);
  },

  'math_gt': (ctx, args) => (args.a as number) > (args.b as number),

  'vec_get_element': (ctx, args) => {
    const vec = args.vec as any;
    const index = args.index as number;
    return vec[index];
  },

  'vec2': (ctx, args) => {
    return [args.x, args.y] as VectorValue;
  },

  'vec4': (ctx, args) => {
    return [args.x, args.y, args.z, args.w] as VectorValue;
  },

  // ----------------------------------------------------------------
  // Variables & Flow State
  // ----------------------------------------------------------------
  'var_set': (ctx, args) => {
    ctx.setVar(args.var as string, args.val);
    return args.val; // Pass-through
  },
  'var_get': (ctx, args) => {
    return ctx.getVar(args.var as string);
  },
  'loop_index': (ctx, args) => {
    return ctx.getLoopIndex(args.loop as string);
  },
  'func_return': (ctx, args) => {
    return args.val; // TODO: Handle return flow in executor
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

    let newWidth = 1;
    let newHeight = 1;
    const sizeVal = args.size;

    if (typeof sizeVal === 'number') {
      newWidth = sizeVal;
    } else if (Array.isArray(sizeVal)) {
      newWidth = sizeVal[0];
      newHeight = sizeVal[1] ?? 1;
    }

    const res = ctx.getResource(id);
    res.width = newWidth;
    res.height = newHeight;
    // Reset data on resize?
    if (res.def.persistence.clearOnResize) {
      res.data = [];
    }

    ctx.logAction('resize', id, { width: newWidth, height: newHeight });
  },

  'buffer_store': (ctx, args) => {
    const id = args.buffer as string;
    const idx = args.index as number;
    const val = args.value;
    const res = ctx.getResource(id);
    if (!res.data) res.data = [];
    res.data[idx] = val;
  },

  'buffer_load': (ctx, args) => {
    const id = args.buffer as string;
    const idx = args.index as number;
    const res = ctx.getResource(id);
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
  'cmd_dispatch': (ctx, args) => {
    // Executor handles Logic, this is just for logging fallback if needed
  },
};
