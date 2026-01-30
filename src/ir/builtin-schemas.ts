import { z } from 'zod';
import { BuiltinOp } from './types';

// ------------------------------------------------------------------
// Core Schema Types
// ------------------------------------------------------------------

export interface OpArg<T = any> {
  type: z.ZodType<T>;
  doc: string;
}

export type OpArgMap<T> = {
  [K in keyof T]: OpArg<T[K]>;
};

export interface OpDef<T> {
  doc: string;
  args: OpArgMap<T>;
}

/**
 * Helper to define a Builtin Op with docstrings and strict type verification.
 * Returns a Zod object schema for the arguments.
 */
export function defineOp<T>(def: OpDef<T>): z.ZodObject<any> {
  const shape: any = {};
  for (const [key, arg] of Object.entries(def.args)) {
    shape[key] = (arg as OpArg).type;
  }
  return z.object(shape);
}

// ------------------------------------------------------------------
// Base Types
// ------------------------------------------------------------------

const FloatSchema = z.number();
const IntSchema = z.number().int();
const BoolSchema = z.boolean();
const StringSchema = z.string();

const Float2Schema = z.array(z.number()).length(2);
const Float3Schema = z.array(z.number()).length(3);
const Float4Schema = z.array(z.number()).length(4);
const Float3x3Schema = z.array(z.number()).length(9);
const Float4x4Schema = z.array(z.number()).length(16);

// Flexible types: many operation arguments in Nano IR can be either
// a literal value (number/array) OR a string referencing another node/input.
const RefableFloat = z.union([FloatSchema, z.string()]);
const RefableInt = z.union([IntSchema, z.string()]);
const RefableBool = z.union([BoolSchema, z.string()]);
const RefableVec2 = z.union([Float2Schema, z.string()]);
const RefableVec3 = z.union([Float3Schema, z.string()]);
const RefableVec4 = z.union([Float4Schema, z.string()]);

// Generic types for overloads
const AnyScalar = z.union([FloatSchema, IntSchema, BoolSchema]);
const AnyVector = z.union([Float2Schema, Float3Schema, Float4Schema]);
const AnyMat = z.union([Float3x3Schema, Float4x4Schema]);
const AnyData = z.union([AnyScalar, AnyVector, AnyMat, z.string(), z.array(z.any())]);

// ------------------------------------------------------------------
// Render Pipeline Types (for cmd_draw)
// ------------------------------------------------------------------

const TextureFormatSchema = z.enum([
  'rgba8', 'rgba16f', 'rgba32f', 'r8', 'r16f', 'r32f', 'unknown'
]);

const BlendFactorSchema = z.enum([
  'zero', 'one', 'src', 'one-minus-src', 'src-alpha', 'one-minus-src-alpha',
  'dst', 'one-minus-dst', 'dst-alpha', 'one-minus-dst-alpha'
]);

const BlendComponentSchema = z.object({
  operation: z.enum(['add', 'subtract', 'reverse-subtract', 'min', 'max']).optional(),
  srcFactor: BlendFactorSchema.optional(),
  dstFactor: BlendFactorSchema.optional()
});

const RenderPipelineSchema = z.object({
  topology: z.enum(['point-list', 'line-list', 'line-strip', 'triangle-list', 'triangle-strip']).optional(),
  cullMode: z.enum(['none', 'front', 'back']).optional(),
  frontFace: z.enum(['ccw', 'cw']).optional(),
  depthStencil: z.object({
    format: TextureFormatSchema,
    depthWriteEnabled: z.boolean(),
    depthCompare: z.enum(['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always']),
  }).optional(),
  blend: z.object({
    color: BlendComponentSchema,
    alpha: BlendComponentSchema
  }).optional()
});

// ------------------------------------------------------------------
// Op Definitions
// ------------------------------------------------------------------

// --- Math ---

export const MathBinarySchema = defineOp<{ a: any, b: any }>({
  doc: "Standard binary math operation (add, sub, mul, div, mod, pow, min, max, gt, lt, ge, le, eq, neq).",
  args: {
    a: { type: AnyData, doc: "First operand" },
    b: { type: AnyData, doc: "Second operand" }
  }
});

export const MathUnarySchema = defineOp<{ val: any }>({
  doc: "Standard unary math operation (abs, ceil, floor, sqrt, exp, log, sin, cos, tan, etc.).",
  args: {
    val: { type: AnyData, doc: "Input value" }
  }
});

export const MathClampSchema = defineOp<{ val: any, min: any, max: any }>({
  doc: "Clamp a value between min and max.",
  args: {
    val: { type: AnyData, doc: "Value to clamp" },
    min: { type: AnyData, doc: "Minimum value" },
    max: { type: AnyData, doc: "Maximum value" }
  }
});

export const LiteralSchema = defineOp<{ val: any }>({
  doc: "Constant literal value.",
  args: { val: { type: z.any(), doc: "The literal value (scalar, vector, matrix, array, etc.)" } }
});

// --- Commands ---

export interface CmdDrawArgs {
  target: string;
  vertex: string;
  fragment: string;
  count: any;
  pipeline?: any;
}

export const CmdDrawSchema = defineOp<CmdDrawArgs>({
  doc: "Draw primitives to a target resource.",
  args: {
    target: { type: z.string(), doc: "ID of the target resource (e.g. 'screen')" },
    vertex: { type: z.string(), doc: "ID of the vertex shader function" },
    fragment: { type: z.string(), doc: "ID of the fragment shader function" },
    count: { type: RefableInt, doc: "Number of vertices/indices to draw" },
    pipeline: { type: RenderPipelineSchema.optional(), doc: "Optional render pipeline state" }
  }
});

export const CmdDispatchSchema = defineOp<{ func: string, dispatch: any }>({
  doc: "Dispatch a compute shader.",
  args: {
    func: { type: z.string(), doc: "ID of the compute function" },
    dispatch: { type: z.union([Float3Schema, z.string()]), doc: "Workgroup count [x, y, z] or reference" }
  }
});

// --- Vectors ---

export const Float2ConstructorSchema = defineOp<{ x: any, y: any }>({
  doc: "Construct a float2 from scalars.",
  args: { x: { type: RefableFloat, doc: "X component" }, y: { type: RefableFloat, doc: "Y component" } }
});

export const Float3ConstructorSchema = defineOp<{ x: any, y: any, z: any }>({
  doc: "Construct a float3 from scalars.",
  args: { x: { type: RefableFloat, doc: "X component" }, y: { type: RefableFloat, doc: "Y component" }, z: { type: RefableFloat, doc: "Z component" } }
});

export const Float4ConstructorSchema = defineOp<{ x: any, y: any, z: any, w: any }>({
  doc: "Construct a float4 from scalars.",
  args: { x: { type: RefableFloat, doc: "X component" }, y: { type: RefableFloat, doc: "Y component" }, z: { type: RefableFloat, doc: "Z component" }, w: { type: RefableFloat, doc: "W component" } }
});

export const VecSwizzleSchema = defineOp<{ vec: any, channels: string }>({
  doc: "Swizzle vector components (e.g. 'xy', 'rgba').",
  args: {
    vec: { type: AnyVector, doc: "Source vector" },
    channels: { type: z.string(), doc: "Component selection mask (e.g. 'xy')" }
  }
});

export const VecMixSchema = defineOp<{ a: any, b: any, t: any }>({
  doc: "Linearly interpolate between two vectors.",
  args: {
    a: { type: AnyVector, doc: "First vector" },
    b: { type: AnyVector, doc: "Second vector" },
    t: { type: z.union([FloatSchema, AnyVector, z.string()]), doc: "Interpolation factor" }
  }
});

// --- Matrices ---

export const MatMulSchema = defineOp<{ a: any, b: any }>({
  doc: "Multiply matrices or matrix and vector.",
  args: { a: { type: z.any(), doc: "First operand" }, b: { type: z.any(), doc: "Second operand" } }
});

export const MatUnarySchema = defineOp<{ val: any }>({
  doc: "Matrix unary operation (transpose, inverse).",
  args: { val: { type: AnyMat, doc: "Input matrix" } }
});

// --- Quaternions ---

export const QuatSchema = defineOp<{ x: any, y: any, z: any, w: any }>({
  doc: "Construct a quaternion.",
  args: { x: { type: RefableFloat, doc: "X" }, y: { type: RefableFloat, doc: "Y" }, z: { type: RefableFloat, doc: "Z" }, w: { type: RefableFloat, doc: "W" } }
});

export const QuatMulSchema = defineOp<{ a: any, b: any }>({
  doc: "Multiply quaternions.",
  args: { a: { type: RefableVec4, doc: "First quat" }, b: { type: RefableVec4, doc: "Second quat" } }
});

// --- Structs & Arrays ---

export const StructExtractSchema = defineOp<{ struct: any, field: string }>({
  doc: "Extract a field from a struct.",
  args: { struct: { type: z.any(), doc: "Struct instance" }, field: { type: z.string(), doc: "Field name" } }
});

export const ArraySetSchema = defineOp<{ array: string, index: any, val: any }>({
  doc: "Set an element in an array.",
  args: { array: { type: z.string(), doc: "Array variable name" }, index: { type: RefableInt, doc: "Index" }, val: { type: z.any(), doc: "Value" } }
});

export const ArrayExtractSchema = defineOp<{ array: any, index: any }>({
  doc: "Extract an element from an array.",
  args: { array: { type: z.union([z.array(z.any()), z.string()]), doc: "Array" }, index: { type: RefableInt, doc: "Index" } }
});

// --- Resources ---

export const TextureSampleSchema = defineOp<{ tex: string, uv: any }>({
  doc: "Sample a texture at the given UV coordinates.",
  args: {
    tex: { type: z.string(), doc: "ID of the texture resource" },
    uv: { type: RefableVec2, doc: "UV coordinates [u, v] or reference" }
  }
});

export const BufferLoadSchema = defineOp<{ buffer: string, index: any }>({
  doc: "Load a value from a buffer resource.",
  args: {
    buffer: { type: z.string(), doc: "ID of the buffer resource" },
    index: { type: RefableInt, doc: "Index in the buffer" }
  }
});

export const BufferStoreSchema = defineOp<{ buffer: string, index: any, value: any }>({
  doc: "Store a value into a buffer resource.",
  args: {
    buffer: { type: z.string(), doc: "ID of the buffer resource" },
    index: { type: RefableInt, doc: "Index in the buffer" },
    value: { type: AnyData, doc: "Value to store" }
  }
});

export const ResourceMetaSchema = defineOp<{ resource: string }>({
  doc: "Get resource metadata (size, format).",
  args: { resource: { type: z.string(), doc: "Resource ID" } }
});

// --- Logic & Control ---

export const VarSetSchema = defineOp<{ var: string, val: any }>({
  doc: "Set the value of a local variable.",
  args: {
    var: { type: z.string(), doc: "Name of the variable" },
    val: { type: z.any(), doc: "Value to store" }
  }
});

export const VarGetSchema = defineOp<{ var: string }>({
  doc: "Get the value of a local variable.",
  args: {
    var: { type: z.string(), doc: "Name of the variable" }
  }
});

export const FlowLoopSchema = defineOp<{ count?: any, start?: any, end?: any, body?: string }>({
  doc: "Control flow loop.",
  args: {
    count: { type: RefableInt.optional(), doc: "Number of iterations" },
    start: { type: RefableInt.optional(), doc: "Start index" },
    end: { type: RefableInt.optional(), doc: "End index" },
    body: { type: z.string().optional(), doc: "Node ID of loop body" }
  }
});

// ------------------------------------------------------------------
// Registry
// ------------------------------------------------------------------

export const OpSchemas: Partial<Record<BuiltinOp, z.ZodObject<any>>> = {
  // Math Binary
  'math_add': MathBinarySchema, 'math_sub': MathBinarySchema, 'math_mul': MathBinarySchema,
  'math_div': MathBinarySchema, 'math_mod': MathBinarySchema, 'math_pow': MathBinarySchema,
  'math_min': MathBinarySchema, 'math_max': MathBinarySchema, 'math_gt': MathBinarySchema,
  'math_lt': MathBinarySchema, 'math_ge': MathBinarySchema, 'math_le': MathBinarySchema,
  'math_eq': MathBinarySchema, 'math_neq': MathBinarySchema, 'math_atan2': MathBinarySchema,
  'math_and': MathBinarySchema, 'math_or': MathBinarySchema, 'math_xor': MathBinarySchema,
  'vec_dot': MathBinarySchema,

  'math_div_scalar': defineOp({ doc: "Divide by scalar", args: { val: { type: AnyData, doc: "Value" }, scalar: { type: RefableFloat, doc: "Scalar" } } }),

  // Math Unary
  'math_abs': MathUnarySchema, 'math_ceil': MathUnarySchema, 'math_floor': MathUnarySchema,
  'math_sqrt': MathUnarySchema, 'math_exp': MathUnarySchema, 'math_log': MathUnarySchema,
  'math_sin': MathUnarySchema, 'math_cos': MathUnarySchema, 'math_tan': MathUnarySchema,
  'math_asin': MathUnarySchema, 'math_acos': MathUnarySchema, 'math_atan': MathUnarySchema,
  'math_sinh': MathUnarySchema, 'math_cosh': MathUnarySchema, 'math_tanh': MathUnarySchema,
  'math_sign': MathUnarySchema, 'math_fract': MathUnarySchema, 'math_trunc': MathUnarySchema,
  'math_is_nan': MathUnarySchema, 'math_is_inf': MathUnarySchema, 'math_is_finite': MathUnarySchema,
  'static_cast_int': MathUnarySchema, 'static_cast_float': MathUnarySchema, 'static_cast_bool': MathUnarySchema,
  'math_not': MathUnarySchema,

  // Vector Unary
  'vec_length': defineOp({ doc: "Vector length", args: { a: { type: AnyVector, doc: "Vector" } } }),
  'vec_normalize': defineOp({ doc: "Normalize vector", args: { a: { type: AnyVector, doc: "Vector" } } }),

  // Special Math
  'math_mad': defineOp({ doc: "a * b + c", args: { a: { type: AnyData, doc: "a" }, b: { type: AnyData, doc: "b" }, c: { type: AnyData, doc: "c" } } }),
  'math_clamp': MathClampSchema,
  'literal': LiteralSchema,
  'math_pi': defineOp({ doc: "Pi constant", args: {} }),
  'math_e': defineOp({ doc: "Euler's number constant", args: {} }),

  // Constructors
  'float2': Float2ConstructorSchema,
  'float3': Float3ConstructorSchema,
  'float4': Float4ConstructorSchema,
  'float': defineOp({ doc: "Float constructor", args: { val: { type: RefableFloat, doc: "Value" } } }),
  'int': defineOp({ doc: "Int constructor", args: { val: { type: RefableInt, doc: "Value" } } }),
  'bool': defineOp({ doc: "Bool constructor", args: { val: { type: RefableBool, doc: "Value" } } }),
  'string': defineOp({ doc: "String constructor", args: { val: { type: StringSchema, doc: "Value" } } }),

  // Vectors
  'vec_swizzle': VecSwizzleSchema,
  'vec_mix': VecMixSchema,
  'vec_get_element': defineOp({ doc: "Get element from vector", args: { vec: { type: z.union([AnyVector, z.string()]), doc: "Vector" }, index: { type: RefableInt, doc: "Index" } } }),

  // Resources
  'texture_sample': TextureSampleSchema,
  'texture_load': defineOp({ doc: "Load pixel from texture", args: { tex: { type: z.string(), doc: "Texture" }, coords: { type: RefableVec2, doc: "Coords [x, y]" } } }),
  'texture_store': defineOp({ doc: "Store pixel to texture", args: { tex: { type: z.string(), doc: "Texture" }, coords: { type: RefableVec2, doc: "Coords [x, y]" }, value: { type: RefableVec4, doc: "Color" } } }),
  'buffer_load': BufferLoadSchema,
  'buffer_store': BufferStoreSchema,
  'resource_get_size': ResourceMetaSchema,
  'resource_get_format': ResourceMetaSchema,

  // Matrices
  'float3x3': defineOp({ doc: "3x3 Matrix", args: { m00: { type: FloatSchema, doc: "m00" }, m01: { type: FloatSchema, doc: "m01" }, m02: { type: FloatSchema, doc: "m02" }, m10: { type: FloatSchema, doc: "m10" }, m11: { type: FloatSchema, doc: "m11" }, m12: { type: FloatSchema, doc: "m12" }, m20: { type: FloatSchema, doc: "m20" }, m21: { type: FloatSchema, doc: "m21" }, m22: { type: FloatSchema, doc: "m22" } } }),
  'float4x4': defineOp({ doc: "4x4 Matrix", args: { m00: { type: FloatSchema, doc: "m00" }, m01: { type: FloatSchema, doc: "m01" }, m02: { type: FloatSchema, doc: "m02" }, m03: { type: FloatSchema, doc: "m03" }, m10: { type: FloatSchema, doc: "m10" }, m11: { type: FloatSchema, doc: "m11" }, m12: { type: FloatSchema, doc: "m12" }, m13: { type: FloatSchema, doc: "m13" }, m20: { type: FloatSchema, doc: "m20" }, m21: { type: FloatSchema, doc: "m21" }, m22: { type: FloatSchema, doc: "m22" }, m23: { type: FloatSchema, doc: "m23" }, m30: { type: FloatSchema, doc: "m30" }, m31: { type: FloatSchema, doc: "m31" }, m32: { type: FloatSchema, doc: "m32" }, m33: { type: FloatSchema, doc: "m33" } } }),
  'mat_identity': defineOp({ doc: "Identity matrix", args: { size: { type: RefableInt, doc: "Size (3 or 4)" } } }),
  'mat_mul': MatMulSchema,
  'mat_transpose': MatUnarySchema,
  'mat_inverse': MatUnarySchema,

  // Quaternions
  'quat': QuatSchema,
  'quat_identity': defineOp({ doc: "Identity quat", args: {} }),
  'quat_mul': QuatMulSchema,
  'quat_slerp': defineOp({ doc: "Slerp quats", args: { a: { type: RefableVec4, doc: "a" }, b: { type: RefableVec4, doc: "b" }, t: { type: RefableFloat, doc: "t" } } }),
  'quat_to_float4x4': defineOp({ doc: "Quat to mat4", args: { q: { type: RefableVec4, doc: "q" } } }),
  'quat_rotate': defineOp({ doc: "Rotate vec by quat", args: { vec: { type: RefableVec3, doc: "vec" }, q: { type: RefableVec4, doc: "q" } } }),

  // Structs & Arrays
  'struct_construct': defineOp({ doc: "Construct struct", args: {} }),
  'struct_extract': StructExtractSchema,
  'array_construct': defineOp({ doc: "Construct array", args: {} }),
  'array_set': ArraySetSchema,
  'array_extract': ArrayExtractSchema,
  'array_length': defineOp({ doc: "Array length", args: { array: { type: z.union([z.array(z.any()), z.string()]), doc: "Array" } } }),

  // Commands
  'cmd_draw': CmdDrawSchema,
  'cmd_dispatch': CmdDispatchSchema,
  'cmd_resize_resource': defineOp({ doc: "Resize a resource", args: { resource: { type: z.string(), doc: "Resource ID" }, size: { type: z.union([RefableVec2, RefableInt]), doc: "New size [w, h] or scalar" } } }),

  // Logic / Control
  'var_set': VarSetSchema,
  'var_get': VarGetSchema,
  'const_get': defineOp({ doc: "Get constant", args: { name: { type: z.string(), doc: "Name" } } }),
  'loop_index': defineOp({ doc: "Get loop index", args: { loop: { type: z.string(), doc: "Loop tag" } } }),
  'flow_branch': defineOp({ doc: "Branch based on condition", args: { cond: { type: RefableBool, doc: "Condition" }, true: { type: z.string(), doc: "Node ID for true" }, false: { type: z.string(), doc: "Node ID for false" } } }),
  'flow_loop': FlowLoopSchema,
  'call_func': defineOp({ doc: "Call a function", args: { func: { type: z.string(), doc: "Function ID" } } }),
  'func_return': defineOp({ doc: "Return from function", args: { val: { type: z.any(), doc: "Return value" } } }),
};
