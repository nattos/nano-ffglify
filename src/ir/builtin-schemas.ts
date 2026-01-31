import { z } from 'zod';
import { BuiltinOp } from './types';

// ------------------------------------------------------------------
// Core Schema Types
// ------------------------------------------------------------------

export interface OpArg<T = any> {
  type: z.ZodType<T>;
  doc: string;
  optional?: boolean;
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
    let schema = (arg as OpArg).type;
    if ((arg as OpArg).optional) {
      schema = schema.optional();
    }
    shape[key] = schema;
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

/**
 * Helper to mark a field as accepting either a literal value of type T
 * OR a string reference to another node or input.
 */
export function literalOrRef<T>(schema: z.ZodType<T>) {
  return z.union([schema, z.string()]).describe('literal_or_ref');
}

// Flexible types: many operation arguments in Nano IR can be either
// a literal value (number/array) OR a string referencing another node/input.
const RefableFloat = literalOrRef(FloatSchema);
const RefableInt = literalOrRef(IntSchema);
const RefableBool = literalOrRef(BoolSchema);
const RefableVec2 = literalOrRef(Float2Schema);
const RefableVec3 = literalOrRef(Float3Schema);
const RefableVec4 = literalOrRef(Float4Schema);

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

// --- Generic Argument Interfaces ---

export interface EmptyArgs { }
export interface ScalarArgs { val: any; }
export interface VecUnaryArgs { a: any; }
export interface TernaryArgs { a: any; b: any; c: any; }
export interface MathDivScalarArgs { val: any; scalar: any; }
export interface VecGetElementArgs { vec: any; index: any; }
export interface TextureLoadArgs { tex: string; coords: any; }
export interface TextureStoreArgs { tex: string; coords: any; value: any; }
export interface Mat3x3Args { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number; m20: number; m21: number; m22: number; }
export interface Mat4x4Args { m00: number; m01: number; m02: number; m03: number; m10: number; m11: number; m12: number; m13: number; m20: number; m21: number; m22: number; m23: number; m30: number; m31: number; m32: number; m33: number; }
export interface MatIdentityArgs { size: any; }
export interface QuatSlerpArgs { a: any; b: any; t: any; }
export interface QuatRotateArgs { vec: any; q: any; }
export interface ConstGetArgs { name: string; }
export interface LoopIndexArgs { loop: string; }
export interface FlowBranchArgs { cond: any; true: string; false: string; }
export interface CallFuncArgs { func: string;[key: string]: any; }
export interface CmdResizeResourceArgs { resource: string; size: any; clear?: any; }
export interface FuncReturnArgs { val: any; value?: any; }
export interface QuatToMatArgs { q: any; }

// --- Math ---

export interface MathBinaryArgs { a: any; b: any; }
export const MathBinarySchema = defineOp<MathBinaryArgs>({
  doc: "Standard binary math operation (add, sub, mul, div, mod, pow, min, max, gt, lt, ge, le, eq, neq).",
  args: {
    a: { type: AnyData, doc: "First operand" },
    b: { type: AnyData, doc: "Second operand" }
  }
});

export interface MathUnaryArgs { val: any; }
export const MathUnarySchema = defineOp<MathUnaryArgs>({
  doc: "Standard unary math operation (abs, ceil, floor, sqrt, exp, log, sin, cos, tan, etc.).",
  args: {
    val: { type: AnyData, doc: "Input value" }
  }
});

export interface MathClampArgs { val: any; min: any; max: any; }
export const MathClampSchema = defineOp<MathClampArgs>({
  doc: "Clamp a value between min and max.",
  args: {
    val: { type: AnyData, doc: "Value to clamp" },
    min: { type: AnyData, doc: "Minimum value" },
    max: { type: AnyData, doc: "Maximum value" }
  }
});

export interface LiteralArgs { val: any; }
export const LiteralSchema = defineOp<LiteralArgs>({
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
    pipeline: { type: RenderPipelineSchema, doc: "Optional render pipeline state", optional: true }
  }
});

export interface CmdDispatchArgs { func: string; dispatch: any; }
export const CmdDispatchSchema = defineOp<CmdDispatchArgs>({
  doc: "Dispatch a compute shader.",
  args: {
    func: { type: z.string(), doc: "ID of the compute function" },
    dispatch: { type: z.union([Float3Schema, z.string()]), doc: "Workgroup count [x, y, z] or reference" }
  }
});

// --- Vectors ---

export interface Float2Args { x: any; y: any; }
export const Float2ConstructorSchema = defineOp<Float2Args>({
  doc: "Construct a float2 from scalars.",
  args: { x: { type: RefableFloat, doc: "X component" }, y: { type: RefableFloat, doc: "Y component" } }
});

export interface Float3Args { x: any; y: any; z: any; }
export const Float3ConstructorSchema = defineOp<Float3Args>({
  doc: "Construct a float3 from scalars.",
  args: { x: { type: RefableFloat, doc: "X component" }, y: { type: RefableFloat, doc: "Y component" }, z: { type: RefableFloat, doc: "Z component" } }
});

export interface Float4Args { x: any; y: any; z: any; w: any; }
export const Float4ConstructorSchema = defineOp<Float4Args>({
  doc: "Construct a float4 from scalars.",
  args: { x: { type: RefableFloat, doc: "X component" }, y: { type: RefableFloat, doc: "Y component" }, z: { type: RefableFloat, doc: "Z component" }, w: { type: RefableFloat, doc: "W component" } }
});

export interface VecSwizzleArgs { vec: any; channels: string; }
export const VecSwizzleSchema = defineOp<VecSwizzleArgs>({
  doc: "Swizzle vector components (e.g. 'xy', 'rgba').",
  args: {
    vec: { type: literalOrRef(AnyVector), doc: "Source vector" },
    channels: { type: z.string(), doc: "Component selection mask (e.g. 'xy')" }
  }
});

export interface VecMixArgs { a: any; b: any; t: any; }
export const VecMixSchema = defineOp<VecMixArgs>({
  doc: "Linearly interpolate between two vectors.",
  args: {
    a: { type: literalOrRef(AnyVector), doc: "First vector" },
    b: { type: literalOrRef(AnyVector), doc: "Second vector" },
    t: { type: z.union([RefableFloat, literalOrRef(AnyVector)]), doc: "Interpolation factor" }
  }
});

// --- Matrices ---

export interface MatMulArgs { a: any; b: any; }
export const MatMulSchema = defineOp<MatMulArgs>({
  doc: "Multiply matrices or matrix and vector.",
  args: { a: { type: z.any(), doc: "First operand" }, b: { type: z.any(), doc: "Second operand" } }
});

export interface MatUnaryArgs { val: any; }
export const MatUnarySchema = defineOp<MatUnaryArgs>({
  doc: "Matrix unary operation (transpose, inverse).",
  args: { val: { type: literalOrRef(AnyMat), doc: "Input matrix" } }
});

// --- Quaternions ---

export interface QuatArgs { x: any; y: any; z: any; w: any; }
export const QuatSchema = defineOp<QuatArgs>({
  doc: "Construct a quaternion.",
  args: { x: { type: RefableFloat, doc: "X" }, y: { type: RefableFloat, doc: "Y" }, z: { type: RefableFloat, doc: "Z" }, w: { type: RefableFloat, doc: "W" } }
});

export interface QuatMulArgs { a: any; b: any; }
export const QuatMulSchema = defineOp<QuatMulArgs>({
  doc: "Multiply quaternions.",
  args: { a: { type: RefableVec4, doc: "First quat" }, b: { type: RefableVec4, doc: "Second quat" } }
});

// --- Structs & Arrays ---

export interface StructExtractArgs { struct: any; field: string; }
export const StructExtractSchema = defineOp<StructExtractArgs>({
  doc: "Extract a field from a struct.",
  args: { struct: { type: z.any(), doc: "Struct instance" }, field: { type: z.string(), doc: "Field name" } }
});

export interface ArraySetArgs { array: string; index: any; val: any; }
export const ArraySetSchema = defineOp<ArraySetArgs>({
  doc: "Set an element in an array.",
  args: { array: { type: z.string(), doc: "Array variable name" }, index: { type: RefableInt, doc: "Index" }, val: { type: z.any(), doc: "Value" } }
});

export interface ArrayExtractArgs { array: any; index: any; }
export const ArrayExtractSchema = defineOp<ArrayExtractArgs>({
  doc: "Extract an element from an array.",
  args: { array: { type: z.union([z.array(z.any()), z.string()]), doc: "Array" }, index: { type: RefableInt, doc: "Index" } }
});

// --- Resources ---

export interface TextureSampleArgs { tex: string; uv: any; }
export const TextureSampleSchema = defineOp<TextureSampleArgs>({
  doc: "Sample a texture at the given UV coordinates.",
  args: {
    tex: { type: z.string(), doc: "ID of the texture resource" },
    uv: { type: RefableVec2, doc: "UV coordinates [u, v] or reference" }
  }
});

export interface BufferLoadArgs { buffer: string; index: any; }
export const BufferLoadSchema = defineOp<BufferLoadArgs>({
  doc: "Load a value from a buffer resource.",
  args: {
    buffer: { type: z.string(), doc: "ID of the buffer resource" },
    index: { type: RefableInt, doc: "Index in the buffer" }
  }
});

export interface BufferStoreArgs { buffer: string; index: any; value: any; }
export const BufferStoreSchema = defineOp<BufferStoreArgs>({
  doc: "Store a value into a buffer resource.",
  args: {
    buffer: { type: z.string(), doc: "ID of the buffer resource" },
    index: { type: RefableInt, doc: "Index in the buffer" },
    value: { type: AnyData, doc: "Value to store" }
  }
});

export interface ResourceMetaArgs { resource: string; }
export const ResourceMetaSchema = defineOp<ResourceMetaArgs>({
  doc: "Get resource metadata (size, format).",
  args: { resource: { type: z.string(), doc: "Resource ID" } }
});

// --- Logic & Control ---

export interface VarSetArgs { var: string; val: any; }
export const VarSetSchema = defineOp<VarSetArgs>({
  doc: "Set the value of a local variable.",
  args: {
    var: { type: z.string(), doc: "Name of the variable" },
    val: { type: z.any(), doc: "Value to store" }
  }
});

export interface VarGetArgs { var: string; }
export const VarGetSchema = defineOp<VarGetArgs>({
  doc: "Get the value of a local variable.",
  args: {
    var: { type: z.string(), doc: "Name of the variable" }
  }
});

export interface FlowLoopArgs { count?: any; start?: any; end?: any; body?: string; }
export const FlowLoopSchema = defineOp<FlowLoopArgs>({
  doc: "Control flow loop.",
  args: {
    count: { type: RefableInt, doc: "Number of iterations", optional: true },
    start: { type: RefableInt, doc: "Start index", optional: true },
    end: { type: RefableInt, doc: "End index", optional: true },
    body: { type: z.string(), doc: "Node ID of loop body", optional: true }
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

  'math_div_scalar': defineOp<MathDivScalarArgs>({ doc: "Divide by scalar", args: { val: { type: AnyData, doc: "Value" }, scalar: { type: RefableFloat, doc: "Scalar" } } }),

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
  'vec_length': defineOp<VecUnaryArgs>({ doc: "Vector length", args: { a: { type: literalOrRef(AnyVector), doc: "Vector" } } }),
  'vec_normalize': defineOp<VecUnaryArgs>({ doc: "Normalize vector", args: { a: { type: literalOrRef(AnyVector), doc: "Vector" } } }),

  // Special Math
  'math_mad': defineOp<TernaryArgs>({ doc: "a * b + c", args: { a: { type: AnyData, doc: "a" }, b: { type: AnyData, doc: "b" }, c: { type: AnyData, doc: "c" } } }),
  'math_clamp': MathClampSchema,
  'literal': LiteralSchema,
  'math_pi': defineOp<EmptyArgs>({ doc: "Pi constant", args: {} }),
  'math_e': defineOp<EmptyArgs>({ doc: "Euler's number constant", args: {} }),

  // Constructors
  'float2': Float2ConstructorSchema,
  'float3': Float3ConstructorSchema,
  'float4': Float4ConstructorSchema,
  'float': defineOp<ScalarArgs>({ doc: "Float constructor", args: { val: { type: RefableFloat, doc: "Value" } } }),
  'int': defineOp<ScalarArgs>({ doc: "Int constructor", args: { val: { type: RefableInt, doc: "Value" } } }),
  'bool': defineOp<ScalarArgs>({ doc: "Bool constructor", args: { val: { type: RefableBool, doc: "Value" } } }),
  'string': defineOp<ScalarArgs>({ doc: "String constructor", args: { val: { type: StringSchema, doc: "Value" } } }),

  // Vectors
  'vec_swizzle': VecSwizzleSchema,
  'vec_mix': VecMixSchema,
  'vec_get_element': defineOp<VecGetElementArgs>({ doc: "Get element from vector", args: { vec: { type: literalOrRef(AnyVector), doc: "Vector" }, index: { type: RefableInt, doc: "Index" } } }),

  // Resources
  'texture_sample': TextureSampleSchema,
  'texture_load': defineOp<TextureLoadArgs>({ doc: "Load pixel from texture", args: { tex: { type: z.string(), doc: "Texture" }, coords: { type: RefableVec2, doc: "Coords [x, y]" } } }),
  'texture_store': defineOp<TextureStoreArgs>({ doc: "Store pixel to texture", args: { tex: { type: z.string(), doc: "Texture" }, coords: { type: RefableVec2, doc: "Coords [x, y]" }, value: { type: RefableVec4, doc: "Color" } } }),
  'buffer_load': BufferLoadSchema,
  'buffer_store': BufferStoreSchema,
  'resource_get_size': ResourceMetaSchema,
  'resource_get_format': ResourceMetaSchema,

  // Matrices
  'float3x3': defineOp<Mat3x3Args>({ doc: "3x3 Matrix", args: { m00: { type: FloatSchema, doc: "m00" }, m01: { type: FloatSchema, doc: "m01" }, m02: { type: FloatSchema, doc: "m02" }, m10: { type: FloatSchema, doc: "m10" }, m11: { type: FloatSchema, doc: "m11" }, m12: { type: FloatSchema, doc: "m12" }, m20: { type: FloatSchema, doc: "m20" }, m21: { type: FloatSchema, doc: "m21" }, m22: { type: FloatSchema, doc: "m22" } } }),
  'float4x4': defineOp<Mat4x4Args>({ doc: "4x4 Matrix", args: { m00: { type: FloatSchema, doc: "m00" }, m01: { type: FloatSchema, doc: "m01" }, m02: { type: FloatSchema, doc: "m02" }, m03: { type: FloatSchema, doc: "m03" }, m10: { type: FloatSchema, doc: "m10" }, m11: { type: FloatSchema, doc: "m11" }, m12: { type: FloatSchema, doc: "m12" }, m13: { type: FloatSchema, doc: "m13" }, m20: { type: FloatSchema, doc: "m20" }, m21: { type: FloatSchema, doc: "m21" }, m22: { type: FloatSchema, doc: "m22" }, m23: { type: FloatSchema, doc: "m23" }, m30: { type: FloatSchema, doc: "m30" }, m31: { type: FloatSchema, doc: "m31" }, m32: { type: FloatSchema, doc: "m32" }, m33: { type: FloatSchema, doc: "m33" } } }),
  'mat_identity': defineOp<MatIdentityArgs>({ doc: "Identity matrix", args: { size: { type: RefableInt, doc: "Size (3 or 4)" } } }),
  'mat_mul': MatMulSchema,
  'mat_transpose': MatUnarySchema,
  'mat_inverse': MatUnarySchema,

  // Quaternions
  'quat': QuatSchema,
  'quat_identity': defineOp<EmptyArgs>({ doc: "Identity quat", args: {} }),
  'quat_mul': QuatMulSchema,
  'quat_slerp': defineOp<QuatSlerpArgs>({ doc: "Slerp quats", args: { a: { type: RefableVec4, doc: "a" }, b: { type: RefableVec4, doc: "b" }, t: { type: RefableFloat, doc: "t" } } }),
  'quat_to_float4x4': defineOp<QuatToMatArgs>({ doc: "Quat to mat4", args: { q: { type: RefableVec4, doc: "q" } } }),
  'quat_rotate': defineOp<QuatRotateArgs>({ doc: "Rotate vec by quat", args: { vec: { type: RefableVec3, doc: "vec" }, q: { type: RefableVec4, doc: "q" } } }),

  // Structs & Arrays
  'struct_construct': defineOp<EmptyArgs>({ doc: "Construct struct", args: {} }),
  'struct_extract': StructExtractSchema,
  'array_construct': defineOp<EmptyArgs>({ doc: "Construct array", args: {} }),
  'array_set': ArraySetSchema,
  'array_extract': ArrayExtractSchema,
  'array_length': defineOp<{ array: any }>({ doc: "Array length", args: { array: { type: z.union([z.array(z.any()), z.string()]), doc: "Array" } } }),

  // Commands
  'cmd_draw': CmdDrawSchema,
  'cmd_dispatch': CmdDispatchSchema,
  'cmd_resize_resource': defineOp<CmdResizeResourceArgs>({ doc: "Resize a resource", args: { resource: { type: z.string(), doc: "Resource ID" }, size: { type: z.union([RefableVec2, RefableInt]), doc: "New size [w, h] or scalar" }, clear: { type: z.any(), doc: "Optional clear value", optional: true } } }),

  // Logic / Control
  'var_set': VarSetSchema,
  'var_get': VarGetSchema,
  'const_get': defineOp<ConstGetArgs>({ doc: "Get constant", args: { name: { type: z.string(), doc: "Name" } } }),
  'loop_index': defineOp<LoopIndexArgs>({ doc: "Get loop index", args: { loop: { type: z.string(), doc: "Loop tag" } } }),
  'flow_branch': defineOp<FlowBranchArgs>({ doc: "Branch based on condition", args: { cond: { type: RefableBool, doc: "Condition" }, true: { type: z.string(), doc: "Node ID for true" }, false: { type: z.string(), doc: "Node ID for false" } } }),
  'flow_loop': FlowLoopSchema,
  'call_func': defineOp<CallFuncArgs>({ doc: "Call a function", args: { func: { type: z.string(), doc: "Function ID" } } }),
  'func_return': defineOp<FuncReturnArgs>({ doc: "Return from function", args: { val: { type: z.any(), doc: "Return value", optional: true }, value: { type: z.any(), doc: "Return value (alias)", optional: true } } }),


};

/**
 * Mapped type of all BuiltinOp arguments.
 */
export type OpArgs = {
  'math_add': MathBinaryArgs; 'math_sub': MathBinaryArgs; 'math_mul': MathBinaryArgs;
  'math_div': MathBinaryArgs; 'math_mod': MathBinaryArgs; 'math_pow': MathBinaryArgs;
  'math_min': MathBinaryArgs; 'math_max': MathBinaryArgs; 'math_gt': MathBinaryArgs;
  'math_lt': MathBinaryArgs; 'math_ge': MathBinaryArgs; 'math_le': MathBinaryArgs;
  'math_eq': MathBinaryArgs; 'math_neq': MathBinaryArgs; 'math_atan2': MathBinaryArgs;
  'math_and': MathBinaryArgs; 'math_or': MathBinaryArgs; 'math_xor': MathBinaryArgs;
  'vec_dot': MathBinaryArgs;
  'math_div_scalar': MathDivScalarArgs;
  'math_abs': MathUnaryArgs; 'math_ceil': MathUnaryArgs; 'math_floor': MathUnaryArgs;
  'math_sqrt': MathUnaryArgs; 'math_exp': MathUnaryArgs; 'math_log': MathUnaryArgs;
  'math_sin': MathUnaryArgs; 'math_cos': MathUnaryArgs; 'math_tan': MathUnaryArgs;
  'math_asin': MathUnaryArgs; 'math_acos': MathUnaryArgs; 'math_atan': MathUnaryArgs;
  'math_sinh': MathUnaryArgs; 'math_cosh': MathUnaryArgs; 'math_tanh': MathUnaryArgs;
  'math_sign': MathUnaryArgs; 'math_fract': MathUnaryArgs; 'math_trunc': MathUnaryArgs;
  'math_is_nan': MathUnaryArgs; 'math_is_inf': MathUnaryArgs; 'math_is_finite': MathUnaryArgs;
  'static_cast_int': MathUnaryArgs; 'static_cast_float': MathUnaryArgs; 'static_cast_bool': MathUnaryArgs;
  'math_not': MathUnaryArgs;
  'vec_length': VecUnaryArgs;
  'vec_normalize': VecUnaryArgs;
  'math_mad': TernaryArgs;
  'math_clamp': MathClampArgs;
  'literal': LiteralArgs;
  'math_pi': EmptyArgs;
  'math_e': EmptyArgs;
  'float2': Float2Args;
  'float3': Float3Args;
  'float4': Float4Args;
  'float': ScalarArgs;
  'int': ScalarArgs;
  'bool': ScalarArgs;
  'string': ScalarArgs;
  'vec_swizzle': VecSwizzleArgs;
  'vec_mix': VecMixArgs;
  'vec_get_element': VecGetElementArgs;
  'texture_sample': TextureSampleArgs;
  'texture_load': TextureLoadArgs;
  'texture_store': TextureStoreArgs;
  'buffer_load': BufferLoadArgs;
  'buffer_store': BufferStoreArgs;
  'resource_get_size': ResourceMetaArgs;
  'resource_get_format': ResourceMetaArgs;
  'float3x3': Mat3x3Args;
  'float4x4': Mat4x4Args;
  'mat_identity': MatIdentityArgs;
  'mat_mul': MatMulArgs;
  'mat_transpose': MatUnaryArgs;
  'mat_inverse': MatUnaryArgs;
  'quat': QuatArgs;
  'quat_identity': EmptyArgs;
  'quat_mul': QuatMulArgs;
  'quat_slerp': QuatSlerpArgs;
  'quat_to_float4x4': QuatToMatArgs;
  'quat_rotate': QuatRotateArgs;
  'struct_construct': EmptyArgs;
  'struct_extract': StructExtractArgs;
  'array_construct': EmptyArgs;
  'array_set': ArraySetArgs;
  'array_extract': ArrayExtractArgs;
  'array_length': { array: any };
  'cmd_draw': CmdDrawArgs;
  'cmd_dispatch': CmdDispatchArgs;
  'cmd_resize_resource': CmdResizeResourceArgs;
  'var_set': VarSetArgs;
  'var_get': VarGetArgs;
  'const_get': ConstGetArgs;
  'loop_index': LoopIndexArgs;
  'flow_branch': FlowBranchArgs;
  'flow_loop': FlowLoopArgs;
  'call_func': CallFuncArgs;
  'func_return': FuncReturnArgs;
};

import { Node } from './types';

/**
 * Type guard for IR nodes to narrow them to specific BuiltinOps.
 */
export function isOp<K extends keyof OpArgs>(node: Node, op: K): node is Node & OpArgs[K] {
  return node.op === op;
}
