import { z } from 'zod';
import { BuiltinOp, Node } from './types';

// ------------------------------------------------------------------
// Core Schema Types
// ------------------------------------------------------------------

export type IRValueType =
  | 'float' | 'int' | 'bool' | 'string'
  | 'float2' | 'float3' | 'float4'
  | 'float3x3' | 'float4x4'
  | 'array' | 'struct';

export type RefType = 'data' | 'exec' | 'var' | 'func' | 'resource' | 'struct' | 'builtin' | 'loop' | 'field' | 'const';

export interface OpArg<T = any> {
  type: z.ZodType<T>;
  doc: string;
  optional?: boolean;
  refable?: boolean;
  requiredRef?: boolean;
  literalTypes?: IRValueType[];
  refType?: RefType; // Default is 'data' if refable/requiredRef
  isArray?: boolean;
}

export interface OpDef<T = any> {
  doc: string;
  args: { [K in keyof T]: OpArg<T[K]> };
  isDynamic?: boolean; // For nodes with arbitrary arguments (call_func, struct_construct)
}

/**
 * Helper to define a Builtin Op with docstrings and strict type verification.
 */
export function defineOp<T>(def: OpDef<T>): OpDef<T> {
  return def;
}

/**
 * Converts an OpDef into a Zod schema.
 */
export function makeZodSchema(def: OpDef<any>): z.ZodObject<any> {
  const shape: any = {};
  for (const [key, arg] of Object.entries(def.args)) {
    let schema = arg.type;
    if (arg.refable || arg.requiredRef) {
      if (arg.requiredRef) {
        schema = z.string();
      } else {
        schema = z.union([schema, z.string()]);
      }
    }
    if (arg.optional) {
      schema = schema.optional();
    }
    shape[key] = schema;
  }
  const schema = z.object(shape);
  return def.isDynamic ? schema.passthrough() : schema;
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
// NOTE: We no longer use literalOrRef(T) description tricks.
// Instead, we use the 'refable: true' flag in OpArg.

// Generic types for overloads
const AnyScalar = z.union([FloatSchema, IntSchema, BoolSchema]);
const AnyVector = z.union([Float2Schema, Float3Schema, Float4Schema]);
const AnyMat = z.union([Float3x3Schema, Float4x4Schema]);
const AnyData = z.union([AnyScalar, AnyVector, AnyMat, z.array(z.any())]);

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

export interface EmptyArgs { [key: string]: any; }
export interface ScalarArgs { val: any;[key: string]: any; }
export interface VecUnaryArgs { a: any;[key: string]: any; }
export interface MadArgs { a: any; b: any; c: any;[key: string]: any; }
export interface ColorMixArgs { a: any; b: any; t: any;[key: string]: any; }
export interface MathDivScalarArgs { val: any; scalar: any;[key: string]: any; }
export interface VecGetElementArgs { vec: any; index: any;[key: string]: any; }
export interface TextureLoadArgs { tex: string; coords: any;[key: string]: any; }
export interface TextureStoreArgs { tex: string; coords: any; value: any;[key: string]: any; }
export interface Mat3x3Args { m00?: number; m01?: number; m02?: number; m10?: number; m11?: number; m12?: number; m20?: number; m21?: number; m22?: number; cols?: any; vals?: any;[key: string]: any; }
export interface Mat4x4Args { m00?: number; m01?: number; m02?: number; m03?: number; m10?: number; m11?: number; m12?: number; m13?: number; m20?: number; m21?: number; m22?: number; m23?: number; m30?: number; m31?: number; m32?: number; m33?: number; cols?: any; vals?: any;[key: string]: any; }
export interface MatIdentityArgs { size: any;[key: string]: any; }
export interface QuatSlerpArgs { a: any; b: any; t: any;[key: string]: any; }
export interface QuatRotateArgs { v: any; q: any;[key: string]: any; }
export interface ConstGetArgs { name: string;[key: string]: any; }
export interface LoopIndexArgs { loop: string;[key: string]: any; }
export interface FlowBranchArgs { cond: any; exec_true: string; exec_false: string;[key: string]: any; }
export interface CallFuncArgs { func: string; args?: Record<string, any>; }
export interface CmdResizeResourceArgs { resource: string; size: any; clear?: any;[key: string]: any; }
export interface CmdSyncToCpuArgs { resource: string;[key: string]: any; }
export interface CmdWaitCpuSyncArgs { resource: string;[key: string]: any; }
export interface FuncReturnArgs { val: any; value?: any;[key: string]: any; }
export interface QuatToMatArgs { q: any;[key: string]: any; }
export interface FlowLoopArgs { count?: any; start?: any; end?: any; exec_body: string; exec_completed?: string; tag?: string;[key: string]: any; }
export interface MathStepArgs { edge: any; x: any;[key: string]: any; }
export interface MathSmoothstepArgs { edge0: any; edge1: any; x: any;[key: string]: any; }
export interface MathMixArgs { a: any; b: any; t: any;[key: string]: any; }
export interface MathLdexpArgs { val: any; exp: any;[key: string]: any; }
export interface MatExtractArgs { mat: any; col: any; row: any;[key: string]: any; }
export interface LiteralArgs { val: any;[key: string]: any; }
export interface Float2Args { x: any; y: any;[key: string]: any; }
export interface Float3Args { x: any; y: any; z: any;[key: string]: any; }
export interface Float4Args { x: any; y: any; z: any; w: any;[key: string]: any; }
export interface BufferLoadArgs { buffer: string; index: any;[key: string]: any; }
export interface BufferStoreArgs { buffer: string; index: any; value: any;[key: string]: any; }
export interface ResourceMetaArgs { resource: string;[key: string]: any; }
export interface MatMulArgs { a: any; b: any;[key: string]: any; }
export interface MatUnaryArgs { val: any;[key: string]: any; }
export interface QuatMulArgs { a: any; b: any;[key: string]: any; }
export interface DynamicArgs { [key: string]: any; }

export interface StructConstructArgs { type: string; values?: Record<string, any>; }
export interface CmdDispatchArgs { func: string; dispatch?: any; args?: Record<string, any>; }
export interface CallFuncArgs { func: string; args?: Record<string, any>; }

export interface ArrayConstructArgs {
  values?: any[];
  type?: string;
  length?: number;
  fill?: any;
}

// --- Math ---

export interface MathBinaryArgs { a: any; b: any;[key: string]: any; }

/**
 * Numeric binary ops (add, sub, mul, div, mod, pow, min, max, atan2, vec_dot)
 */
export const MathNumericBinaryDef = defineOp<MathBinaryArgs>({
  doc: "Standard numeric binary math operation.",
  args: {
    a: { type: AnyData, doc: "First operand", refable: true, literalTypes: ['float', 'int', 'float2', 'float3', 'float4'] },
    b: { type: AnyData, doc: "Second operand", refable: true, literalTypes: ['float', 'int', 'float2', 'float3', 'float4'] }
  }
});

/**
 * Logic binary ops (and, or, xor)
 */
export const MathLogicBinaryDef = defineOp<MathBinaryArgs>({
  doc: "Standard logic binary operation.",
  args: {
    a: { type: AnyData, doc: "First operand", refable: true, literalTypes: ['bool', 'float', 'int'] },
    b: { type: AnyData, doc: "Second operand", refable: true, literalTypes: ['bool', 'float', 'int'] }
  }
});

/**
 * Comparison ops (gt, lt, ge, le) - numeric inputs
 */
export const MathCompareBinaryDef = defineOp<MathBinaryArgs>({
  doc: "Comparison operation with numeric inputs.",
  args: {
    a: { type: AnyData, doc: "First operand", refable: true, literalTypes: ['float', 'int', 'float2', 'float3', 'float4'] },
    b: { type: AnyData, doc: "Second operand", refable: true, literalTypes: ['float', 'int', 'float2', 'float3', 'float4'] }
  }
});

/**
 * Equality ops (eq, neq) - broad inputs
 */
export const MathEqualityBinaryDef = defineOp<MathBinaryArgs>({
  doc: "Equality comparison operation.",
  args: {
    a: { type: AnyData, doc: "First operand", refable: true, literalTypes: ['float', 'int', 'bool', 'float2', 'float3', 'float4'] },
    b: { type: AnyData, doc: "Second operand", refable: true, literalTypes: ['float', 'int', 'bool', 'float2', 'float3', 'float4'] }
  }
});

export interface MathUnaryArgs { val: any;[key: string]: any; }

/**
 * Numeric unary ops (abs, ceil, floor, sqrt, exp, log, sin, cos, tan, etc.)
 */
export const MathNumericUnaryDef = defineOp<MathUnaryArgs>({
  doc: "Standard numeric unary math operation.",
  args: {
    val: { type: AnyData, doc: "Input value", refable: true, literalTypes: ['float', 'int', 'float2', 'float3', 'float4'] }
  }
});

/**
 * Logic unary ops (not)
 */
export const MathLogicUnaryDef = defineOp<MathUnaryArgs>({
  doc: "Standard logic unary operation.",
  args: {
    val: { type: AnyData, doc: "Input value", refable: true, literalTypes: ['bool', 'float', 'int'] }
  }
});

/**
 * Casting ops (static_cast_int, etc.) - broad inputs
 */
export const MathCastUnaryDef = defineOp<MathUnaryArgs>({
  doc: "Type-casting unary operation.",
  args: {
    val: { type: AnyData, doc: "Input value", refable: true, literalTypes: ['float', 'int', 'bool', 'string', 'float2', 'float3', 'float4'] }
  }
});

// --- Special Math ---
export const MathClampDef = defineOp<MathClampArgs>({
  doc: "Clamp a value between min and max.",
  args: {
    val: { type: AnyData, doc: "Value to clamp", refable: true },
    min: { type: AnyData, doc: "Minimum value", refable: true },
    max: { type: AnyData, doc: "Maximum value", refable: true }
  }
});

export const LiteralDef = defineOp<LiteralArgs>({
  doc: "Constant literal value.",
  args: { val: { type: z.any(), doc: "The literal value (scalar, vector, matrix, array, etc.)", literalTypes: ['float', 'int', 'bool', 'string', 'float2', 'float3', 'float4', 'float3x3', 'float4x4', 'array', 'struct'] } }
});

// --- Constructors ---
export const Float2ConstructorDef = defineOp<Float2Args>({
  doc: "Construct a float2.",
  args: {
    x: { type: FloatSchema, doc: "X", refable: true, literalTypes: ['float', 'int'] },
    y: { type: FloatSchema, doc: "Y", refable: true, literalTypes: ['float', 'int'] }
  }
});

export const Float3ConstructorDef = defineOp<Float3Args>({
  doc: "Construct a float3.",
  args: { x: { type: FloatSchema, doc: "X", refable: true }, y: { type: FloatSchema, doc: "Y", refable: true }, z: { type: FloatSchema, doc: "Z", refable: true } }
});

export const Float4ConstructorDef = defineOp<Float4Args>({
  doc: "Construct a float4.",
  args: { x: { type: FloatSchema, doc: "X", refable: true }, y: { type: FloatSchema, doc: "Y", refable: true }, z: { type: FloatSchema, doc: "Z", refable: true }, w: { type: FloatSchema, doc: "W", refable: true } }
});

// --- Vectors ---

export interface VecSwizzleArgs { vec: any; channels: string;[key: string]: any; }
export const VecSwizzleDef = defineOp<VecSwizzleArgs>({
  doc: "Swizzle components of a vector.",
  args: {
    vec: { type: AnyVector, doc: "Input vector", refable: true, literalTypes: ['float2', 'float3', 'float4'] },
    channels: { type: z.string(), doc: "Swizzle mask (e.g. 'xyz')", literalTypes: ['string'] }
  }
});

export interface VecMixArgs { a: any; b: any; t: any;[key: string]: any; }
export const VecMixDef = defineOp<VecMixArgs>({
  doc: "Linearly interpolate between two vectors.",
  args: { a: { type: AnyVector, doc: "a", refable: true }, b: { type: AnyVector, doc: "b", refable: true }, t: { type: FloatSchema, doc: "t", refable: true } }
});

// --- Commands ---

export interface CmdDrawArgs {
  target: string;
  vertex: string;
  fragment: string;
  count: any;
  pipeline?: any;
  [key: string]: any;
}

export const CmdDrawDef = defineOp<CmdDrawArgs>({
  doc: "Draw primitives to a target resource.",
  args: {
    target: { type: z.string(), doc: "ID of the target resource (e.g. 'screen')", requiredRef: true, refType: 'resource' },
    vertex: { type: z.string(), doc: "ID of the vertex shader function", requiredRef: true, refType: 'func' },
    fragment: { type: z.string(), doc: "ID of the fragment shader function", requiredRef: true, refType: 'func' },
    count: { type: IntSchema, doc: "Number of vertices/indices to draw", refable: true },
    pipeline: { type: RenderPipelineSchema, doc: "Optional render pipeline state", optional: true }
  }
});

// --- Resources ---

export interface TextureSampleArgs { tex: string; coords: any;[key: string]: any; }
export const TextureSampleDef = defineOp<TextureSampleArgs>({
  doc: "Sample a texture at given coordinates.",
  args: {
    tex: { type: z.string(), doc: "ID of the texture resource", requiredRef: true, refType: 'resource' },
    coords: { type: AnyVector, doc: "Coordinates", refable: true, optional: true },
    uv: { type: AnyVector, doc: "Alias for coords (float2 expected)", refable: true, optional: true }
  }
});

export const TextureLoadDef = defineOp<TextureLoadArgs>({
  doc: "Load pixel from texture",
  args: {
    tex: { type: z.string(), doc: "Texture", requiredRef: true, refType: 'resource' },
    coords: { type: Float2Schema, doc: "Coords [x, y]", refable: true }
  }
});

export const TextureStoreDef = defineOp<TextureStoreArgs>({
  doc: "Store pixel to texture",
  args: {
    tex: { type: z.string(), doc: "Texture", requiredRef: true, refType: 'resource' },
    coords: { type: Float2Schema, doc: "Coords [x, y]", refable: true },
    value: { type: Float4Schema, doc: "Color", refable: true }
  }
});

export const BufferLoadDef = defineOp<BufferLoadArgs>({
  doc: "Load value from a buffer.",
  args: {
    buffer: { type: z.string(), doc: "ID of the buffer resource", requiredRef: true, refType: 'resource' },
    index: { type: IntSchema, doc: "Index", refable: true }
  }
});

export const BufferStoreDef = defineOp<BufferStoreArgs>({
  doc: "Store value to a buffer.",
  args: {
    buffer: { type: z.string(), doc: "ID of the buffer resource", requiredRef: true, refType: 'resource' },
    index: { type: IntSchema, doc: "Index", refable: true },
    value: { type: AnyData, doc: "Value to store", refable: true }
  }
});

export const ResourceMetaDef = defineOp<ResourceMetaArgs>({
  doc: "Get resource metadata (size or format).",
  args: { resource: { type: z.string(), doc: "ID of the resource", requiredRef: true, refType: 'resource' } }
});

// --- Matrices ---

export const Mat3x3Def = defineOp<Mat3x3Args>({
  doc: "3x3 Matrix",
  args: {
    m00: { type: FloatSchema, doc: "m00", optional: true }, m01: { type: FloatSchema, doc: "m01", optional: true }, m02: { type: FloatSchema, doc: "m02", optional: true },
    m10: { type: FloatSchema, doc: "m10", optional: true }, m11: { type: FloatSchema, doc: "m11", optional: true }, m12: { type: FloatSchema, doc: "m12", optional: true },
    m20: { type: FloatSchema, doc: "m20", optional: true }, m21: { type: FloatSchema, doc: "m21", optional: true }, m22: { type: FloatSchema, doc: "m22", optional: true },
    cols: { type: z.any(), doc: "Column vectors", refable: true, optional: true },
    vals: { type: z.any(), doc: "Value array", refable: true, optional: true }
  }
});

export const Mat4x4Def = defineOp<Mat4x4Args>({
  doc: "4x4 Matrix",
  args: {
    m00: { type: FloatSchema, doc: "m00", optional: true }, m01: { type: FloatSchema, doc: "m01", optional: true }, m02: { type: FloatSchema, doc: "m02", optional: true }, m03: { type: FloatSchema, doc: "m03", optional: true },
    m10: { type: FloatSchema, doc: "m10", optional: true }, m11: { type: FloatSchema, doc: "m11", optional: true }, m12: { type: FloatSchema, doc: "m12", optional: true }, m13: { type: FloatSchema, doc: "m13", optional: true },
    m20: { type: FloatSchema, doc: "m20", optional: true }, m21: { type: FloatSchema, doc: "m21", optional: true }, m22: { type: FloatSchema, doc: "m22", optional: true }, m23: { type: FloatSchema, doc: "m23", optional: true },
    m30: { type: FloatSchema, doc: "m30", optional: true }, m31: { type: FloatSchema, doc: "m31", optional: true }, m32: { type: FloatSchema, doc: "m32", optional: true }, m33: { type: FloatSchema, doc: "m33", optional: true },
    cols: { type: z.any(), doc: "Column vectors", refable: true, optional: true },
    vals: { type: z.any(), doc: "Value array", refable: true, optional: true }
  }
});

export const MatIdentityDef = defineOp<MatIdentityArgs>({
  doc: "Identity matrix",
  args: { size: { type: IntSchema, doc: "Size (3 or 4)", refable: true } }
});

export const MatMulDef = defineOp<MatMulArgs>({
  doc: "Matrix multiplication.",
  args: { a: { type: z.any(), doc: "Matrix A", refable: true }, b: { type: z.any(), doc: "Matrix B", refable: true } }
});

export const MatUnaryDef = defineOp<MatUnaryArgs>({
  doc: "Matrix unary operation (transpose, inverse).",
  args: { val: { type: z.any(), doc: "Input matrix", refable: true } }
});

// --- Quaternions ---

export interface QuatArgs { axis: any; angle: any;[key: string]: any; }
export const QuatDef = defineOp<QuatArgs>({
  doc: "Construct a quaternion from axis and angle.",
  args: {
    axis: { type: Float3Schema, doc: "Rotation axis", refable: true, optional: true },
    angle: { type: FloatSchema, doc: "Rotation angle", refable: true, optional: true },
    x: { type: FloatSchema, doc: "x", refable: true, optional: true },
    y: { type: FloatSchema, doc: "y", refable: true, optional: true },
    z: { type: FloatSchema, doc: "z", refable: true, optional: true },
    w: { type: FloatSchema, doc: "w", refable: true, optional: true }
  }
});

export const QuatMulDef = defineOp<QuatMulArgs>({
  doc: "Quaternion multiplication.",
  args: { a: { type: Float4Schema, doc: "Quat A", refable: true }, b: { type: Float4Schema, doc: "Quat B", refable: true } }
});

export const QuatSlerpDef = defineOp<QuatSlerpArgs>({
  doc: "Slerp quats",
  args: { a: { type: Float4Schema, doc: "a", refable: true }, b: { type: Float4Schema, doc: "b", refable: true }, t: { type: FloatSchema, doc: "t", refable: true } }
});

export const QuatToMatDef = defineOp<QuatToMatArgs>({
  doc: "Quat to mat4",
  args: { q: { type: Float4Schema, doc: "q", refable: true } }
});

export const QuatRotateDef = defineOp<QuatRotateArgs>({
  doc: "Rotate vec by quat",
  args: { v: { type: Float3Schema, doc: "vec", refable: true }, q: { type: Float4Schema, doc: "q", refable: true } }
});

export const ColorMixDef = defineOp<ColorMixArgs>({
  doc: "Mix colors",
  args: { a: { type: Float4Schema, doc: "a", refable: true }, b: { type: Float4Schema, doc: "b", refable: true }, t: { type: FloatSchema, doc: "t", refable: true, optional: true } }
});

// --- Structs & Arrays ---

export interface StructExtractArgs { struct: any; field: string;[key: string]: any; }
export const StructExtractDef = defineOp<StructExtractArgs>({
  doc: "Extract a field from a struct.",
  args: { struct: { type: z.any(), doc: "Struct instance", refable: true }, field: { type: z.string(), doc: "Field name", literalTypes: ['string'] } }
});

export interface ArraySetArgs { array: any; index: any; value: any;[key: string]: any; }
export const ArraySetDef = defineOp<ArraySetArgs>({
  doc: "Set an element in an array.",
  args: { array: { type: z.string(), doc: "Array variable name", requiredRef: true, refType: 'var' }, index: { type: IntSchema, doc: "Index", refable: true }, value: { type: z.any(), doc: "Value", refable: true } }
});

export interface ArrayExtractArgs { array: any; index: any;[key: string]: any; }
export const ArrayExtractDef = defineOp<ArrayExtractArgs>({
  doc: "Extract an element from an array.",
  args: { array: { type: z.any(), doc: "Array", refable: true, refType: 'data' }, index: { type: IntSchema, doc: "Index", refable: true } }
});

// --- Logic & Control ---

export const BuiltinNameSchema = z.enum([
  'position',
  'vertex_index',
  'instance_index',
  'global_invocation_id',
  'local_invocation_id',
  'workgroup_id',
  'local_invocation_index',
  'num_workgroups',
  'frag_coord',
  'front_facing',
  'sample_index',
  'sample_mask',
  'subgroup_invocation_id',
  'subgroup_size'
]);

export interface BuiltinGetArgs { name: string;[key: string]: any; }
export const BuiltinGetDef = defineOp<BuiltinGetArgs>({
  doc: "Get a GPU/Shader built-in variable.",
  args: { name: { type: BuiltinNameSchema, doc: "Built-in name", refType: 'builtin' } }
});

export interface VarSetArgs { var: string; val: any;[key: string]: any; }
export const VarSetDef = defineOp<VarSetArgs>({
  doc: "Set the value of a local variable.",
  args: {
    var: { type: z.string(), doc: "Name of the variable", literalTypes: ['string'], refType: 'var' },
    val: { type: z.any(), doc: "Value to store", refable: true }
  }
});

export interface MathClampArgs { val: any; min: any; max: any;[key: string]: any; }

export interface VarGetArgs { var: string;[key: string]: any; }
export const VarGetDef = defineOp<VarGetArgs>({
  doc: "Get the value of a local variable.",
  args: { var: { type: z.string(), doc: "Name of the variable", requiredRef: true, refType: 'var' } }
});

export const FlowLoopDef = defineOp<FlowLoopArgs>({
  doc: "Loop over a sequence.",
  args: {
    count: { type: IntSchema, doc: "Number of iterations", refable: true, optional: true },
    start: { type: IntSchema, doc: "Start index", refable: true, optional: true },
    end: { type: IntSchema, doc: "End index", refable: true, optional: true },
    exec_body: { type: z.string(), doc: "Node ID for loop body", requiredRef: true, optional: true, refType: 'exec' },
    exec_completed: { type: z.string(), doc: "Node ID for after loop", requiredRef: true, optional: true, refType: 'exec' },
    tag: { type: z.string(), doc: "Loop tag for identification", optional: true, refable: true }
  }
});

// --- Registry ---

export const OpDefs: Record<BuiltinOp, OpDef<any>> = {
  // Math Binary
  'math_add': MathNumericBinaryDef, 'math_sub': MathNumericBinaryDef, 'math_mul': MathNumericBinaryDef,
  'math_div': MathNumericBinaryDef, 'math_mod': MathNumericBinaryDef, 'math_pow': MathNumericBinaryDef,
  'math_min': MathNumericBinaryDef, 'math_max': MathNumericBinaryDef,
  'math_gt': MathCompareBinaryDef, 'math_lt': MathCompareBinaryDef,
  'math_ge': MathCompareBinaryDef, 'math_le': MathCompareBinaryDef,
  'math_eq': MathEqualityBinaryDef, 'math_neq': MathEqualityBinaryDef,
  'math_atan2': MathNumericBinaryDef,
  'math_and': MathLogicBinaryDef, 'math_or': MathLogicBinaryDef, 'math_xor': MathLogicBinaryDef,
  'vec_dot': MathNumericBinaryDef,

  'math_div_scalar': defineOp<MathDivScalarArgs>({ doc: "Divide by scalar", args: { val: { type: AnyData, doc: "Value", refable: true }, scalar: { type: FloatSchema, doc: "Scalar", refable: true } } }),

  // Math Unary
  'math_abs': MathNumericUnaryDef, 'math_ceil': MathNumericUnaryDef, 'math_floor': MathNumericUnaryDef,
  'math_sqrt': MathNumericUnaryDef, 'math_exp': MathNumericUnaryDef, 'math_log': MathNumericUnaryDef,
  'math_sin': MathNumericUnaryDef, 'math_cos': MathNumericUnaryDef, 'math_tan': MathNumericUnaryDef,
  'math_asin': MathNumericUnaryDef, 'math_acos': MathNumericUnaryDef, 'math_atan': MathNumericUnaryDef,
  'math_asinh': MathNumericUnaryDef, 'math_acosh': MathNumericUnaryDef, 'math_atanh': MathNumericUnaryDef,
  'math_sinh': MathNumericUnaryDef, 'math_cosh': MathNumericUnaryDef, 'math_tanh': MathNumericUnaryDef,
  'math_sign': MathNumericUnaryDef, 'math_fract': MathNumericUnaryDef, 'math_trunc': MathNumericUnaryDef,
  'math_round': MathNumericUnaryDef,
  'math_is_nan': MathNumericUnaryDef, 'math_is_inf': MathNumericUnaryDef, 'math_is_finite': MathNumericUnaryDef,
  'static_cast_int': MathCastUnaryDef, 'static_cast_uint': MathCastUnaryDef, 'static_cast_float': MathCastUnaryDef, 'static_cast_bool': MathCastUnaryDef,
  'math_not': MathLogicUnaryDef,

  // Vector Unary
  'vec_length': defineOp<VecUnaryArgs>({ doc: "Vector length", args: { a: { type: AnyVector, doc: "Vector", refable: true } } }),
  'vec_normalize': defineOp<VecUnaryArgs>({ doc: "Normalize vector", args: { a: { type: AnyVector, doc: "Vector", refable: true } } }),

  // Special Math
  'math_mad': defineOp<MadArgs>({ doc: "a * b + c", args: { a: { type: AnyData, doc: "a", refable: true }, b: { type: AnyData, doc: "b", refable: true }, c: { type: AnyData, doc: "c", refable: true } } }),
  'math_clamp': MathClampDef,
  'math_step': defineOp<MathStepArgs>({ doc: "Step function", args: { edge: { type: AnyData, doc: "Edge", refable: true }, x: { type: AnyData, doc: "x", refable: true } } }),
  'math_smoothstep': defineOp<MathSmoothstepArgs>({ doc: "Smoothstep function", args: { edge0: { type: AnyData, doc: "Edge 0", refable: true }, edge1: { type: AnyData, doc: "Edge 1", refable: true }, x: { type: AnyData, doc: "x", refable: true } } }),
  'math_mix': defineOp<MathMixArgs>({ doc: "Linear interpolation", args: { a: { type: AnyData, doc: "a", refable: true }, b: { type: AnyData, doc: "b", refable: true }, t: { type: AnyData, doc: "t", refable: true } } }),
  'literal': LiteralDef,
  'math_pi': defineOp<EmptyArgs>({ doc: "Pi constant", args: {} }),
  'math_e': defineOp<EmptyArgs>({ doc: "Euler's number constant", args: {} }),

  // Constructors
  'float2': Float2ConstructorDef,
  'float3': Float3ConstructorDef,
  'float4': Float4ConstructorDef,
  'float': defineOp<ScalarArgs>({ doc: "Float constructor", args: { val: { type: FloatSchema, doc: "Value", refable: true } } }),
  'int': defineOp<ScalarArgs>({ doc: "Int constructor", args: { val: { type: IntSchema, doc: "Value", refable: true } } }),
  'uint': defineOp<ScalarArgs>({ doc: "Uint constructor", args: { val: { type: IntSchema, doc: "Value", refable: true } } }),
  'bool': defineOp<ScalarArgs>({ doc: "Bool constructor", args: { val: { type: BoolSchema, doc: "Value", refable: true } } }),
  'string': defineOp<ScalarArgs>({ doc: "String constructor", args: { val: { type: z.string(), doc: "Value" } } }),

  // Vectors
  'vec_swizzle': VecSwizzleDef,
  'vec_mix': VecMixDef,
  'vec_get_element': defineOp<VecGetElementArgs>({ doc: "Get element from vector", args: { vec: { type: AnyVector, doc: "Vector", refable: true }, index: { type: IntSchema, doc: "Index", refable: true } } }),

  // Resources
  'texture_sample': TextureSampleDef,
  'texture_load': TextureLoadDef,
  'texture_store': TextureStoreDef,
  'buffer_load': BufferLoadDef,
  'buffer_store': BufferStoreDef,
  'resource_get_size': ResourceMetaDef,
  'resource_get_format': ResourceMetaDef,

  // Matrices
  'float3x3': Mat3x3Def,
  'float4x4': Mat4x4Def,
  'mat_identity': MatIdentityDef,
  'mat_mul': MatMulDef,
  'mat_transpose': MatUnaryDef,
  'mat_inverse': MatUnaryDef,
  'mat_extract': defineOp<MatExtractArgs>({ doc: "Extract element from matrix", args: { mat: { type: AnyMat, doc: "Matrix", refable: true }, col: { type: IntSchema, doc: "Column", refable: true }, row: { type: IntSchema, doc: "Row", refable: true } } }),

  // Quaternions
  'quat': QuatDef,
  'quat_identity': defineOp<EmptyArgs>({ doc: "Identity quat", args: {} }),
  'quat_mul': QuatMulDef,
  'quat_slerp': QuatSlerpDef,
  'quat_to_float4x4': QuatToMatDef,
  'quat_rotate': QuatRotateDef,
  'color_mix': ColorMixDef,
  'math_flush_subnormal': MathNumericUnaryDef,
  'math_mantissa': MathNumericUnaryDef,
  'math_exponent': MathNumericUnaryDef,
  'math_frexp_mantissa': MathNumericUnaryDef,
  'math_frexp_exponent': MathNumericUnaryDef,
  'math_ldexp': defineOp<MathLdexpArgs>({ doc: "ldexp function", args: { val: { type: AnyData, doc: "Value", refable: true }, exp: { type: AnyData, doc: "Exponent", refable: true } } }),

  // Structs & Arrays
  'struct_construct': defineOp<StructConstructArgs>({
    doc: "Construct struct",
    args: {
      type: { type: z.string(), doc: "Struct type", refType: 'struct' },
      values: { type: z.any(), doc: "Struct fields", optional: true }
    },
    isDynamic: true
  }),
  'struct_extract': StructExtractDef,
  'array_construct': defineOp<ArrayConstructArgs>({
    doc: "Construct array",
    args: {
      values: { type: z.array(z.any()), doc: "Array elements", refable: true, isArray: true, optional: true },
      type: { type: z.string(), doc: "Explicit array type", optional: true, refType: 'struct' },
      length: { type: z.any(), doc: "Array length", optional: true, refable: true },
      fill: { type: z.any(), doc: "Fill value", optional: true, refable: true }
    },
    isDynamic: true
  }),
  'array_set': ArraySetDef,
  'array_extract': ArrayExtractDef,
  'array_length': defineOp<{ array: any }>({ doc: "Array length", args: { array: { type: z.any(), doc: "Array", refable: true, literalTypes: ['array'] } } }),

  // Commands
  'cmd_draw': CmdDrawDef,
  'cmd_dispatch': defineOp<CmdDispatchArgs>({
    doc: "Dispatch compute shader",
    args: {
      func: { type: z.string(), doc: "Shader function ID", requiredRef: true, refType: 'func' },
      dispatch: { type: z.any(), doc: "Dispatch dimensions (vec3<u32> or scalar)", optional: true, refable: true },
      args: { type: z.any(), doc: "Shader arguments", optional: true }
    },
    isDynamic: true
  }),
  'cmd_resize_resource': defineOp<CmdResizeResourceArgs>({ doc: "Resize a resource", args: { resource: { type: z.string(), doc: "Resource ID", requiredRef: true, refType: 'resource' }, size: { type: AnyData, doc: "New size [w, h] or scalar", refable: true, literalTypes: ['float', 'int', 'float2'] }, clear: { type: z.any(), doc: "Optional clear value", optional: true } } }),
  'cmd_sync_to_cpu': defineOp<CmdSyncToCpuArgs>({ doc: "Initiate async readback", args: { resource: { type: z.string(), doc: "Resource ID", requiredRef: true, refType: 'resource' } } }),
  'cmd_wait_cpu_sync': defineOp<CmdWaitCpuSyncArgs>({ doc: "Wait for readback completion", args: { resource: { type: z.string(), doc: "Resource ID", requiredRef: true, refType: 'resource' } } }),

  // Logic / Control
  'var_set': VarSetDef,
  'var_get': VarGetDef,
  'builtin_get': BuiltinGetDef,
  'const_get': defineOp<ConstGetArgs>({ doc: "Get constant", args: { name: { type: z.string(), doc: "Name", refType: 'const' } } }),
  'loop_index': defineOp<LoopIndexArgs>({ doc: "Get loop index", args: { loop: { type: z.string(), doc: "Loop tag", refable: true, refType: 'loop' } } }),
  'flow_branch': defineOp<FlowBranchArgs>({ doc: "Branch based on condition", args: { cond: { type: BoolSchema, doc: "Condition", refable: true }, exec_true: { type: z.string(), doc: "Node ID for true", requiredRef: true, optional: true, refType: 'exec' }, exec_false: { type: z.string(), doc: "Node ID for false", requiredRef: true, optional: true, refType: 'exec' } } }),
  'flow_loop': FlowLoopDef,
  'call_func': defineOp<CallFuncArgs>({
    doc: "Call a function",
    args: {
      func: { type: z.string(), doc: "Function ID", requiredRef: true, refType: 'func' },
      args: { type: z.any(), doc: "Function arguments", optional: true }
    },
    isDynamic: true
  }),
  'func_return': defineOp<FuncReturnArgs>({ doc: "Return from function", args: { val: { type: z.any(), doc: "Return value", optional: true, refable: true }, value: { type: z.any(), doc: "Return value (alias)", optional: true, refable: true } } }),
};

/**
 * Computed Zod schemas for all operations.
 */
export const OpSchemas: Record<BuiltinOp, z.ZodObject<any>> = Object.fromEntries(
  Object.entries(OpDefs).map(([op, def]) => [op, makeZodSchema(def)])
) as any;

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
  'math_asinh': MathUnaryArgs; 'math_acosh': MathUnaryArgs; 'math_atanh': MathUnaryArgs;
  'math_sinh': MathUnaryArgs; 'math_cosh': MathUnaryArgs; 'math_tanh': MathUnaryArgs;
  'math_sign': MathUnaryArgs; 'math_fract': MathUnaryArgs; 'math_trunc': MathUnaryArgs;
  'math_round': MathUnaryArgs;
  'math_is_nan': MathUnaryArgs; 'math_is_inf': MathUnaryArgs; 'math_is_finite': MathUnaryArgs;
  'static_cast_int': MathUnaryArgs; 'static_cast_uint': MathUnaryArgs; 'static_cast_float': MathUnaryArgs; 'static_cast_bool': MathUnaryArgs;
  'math_not': MathUnaryArgs;
  'vec_length': VecUnaryArgs;
  'vec_normalize': VecUnaryArgs;
  'math_mad': MadArgs;
  'math_clamp': MathClampArgs;
  'math_step': MathStepArgs;
  'math_smoothstep': MathSmoothstepArgs;
  'math_mix': MathMixArgs;
  'literal': LiteralArgs;
  'math_pi': EmptyArgs;
  'math_e': EmptyArgs;
  'float2': Float2Args;
  'float3': Float3Args;
  'float4': Float4Args;
  'float': ScalarArgs;
  'int': ScalarArgs;
  'uint': ScalarArgs;
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
  'mat_transpose': MathUnaryArgs;
  'mat_inverse': MathUnaryArgs;
  'mat_extract': MatExtractArgs;
  'quat': QuatArgs;
  'quat_identity': EmptyArgs;
  'quat_mul': QuatMulArgs;
  'quat_slerp': QuatSlerpArgs;
  'quat_to_float4x4': QuatToMatArgs;
  'quat_rotate': QuatRotateArgs;
  'color_mix': ColorMixArgs;
  'math_flush_subnormal': MathUnaryArgs;
  'math_mantissa': MathUnaryArgs;
  'math_exponent': MathUnaryArgs;
  'math_frexp_mantissa': MathUnaryArgs;
  'math_frexp_exponent': MathUnaryArgs;
  'math_ldexp': MathLdexpArgs;
  'struct_construct': StructConstructArgs;
  'struct_extract': StructExtractArgs;
  'array_construct': ArrayConstructArgs;
  'array_set': ArraySetArgs;
  'array_extract': ArrayExtractArgs;
  'array_length': { array: any;[key: string]: any; };
  'cmd_draw': CmdDrawArgs;
  'cmd_dispatch': CmdDispatchArgs;
  'cmd_resize_resource': CmdResizeResourceArgs;
  'cmd_sync_to_cpu': CmdSyncToCpuArgs;
  'cmd_wait_cpu_sync': CmdWaitCpuSyncArgs;
  'var_set': VarSetArgs;
  'var_get': VarGetArgs;
  'builtin_get': BuiltinGetArgs;
  'const_get': ConstGetArgs;
  'loop_index': LoopIndexArgs;
  'flow_branch': FlowBranchArgs;
  'flow_loop': FlowLoopArgs;
  'call_func': CallFuncArgs;
  'func_return': FuncReturnArgs;
};

/**
 * Type guard for IR nodes to narrow them to specific BuiltinOps.
 */
export function isOp<K extends keyof OpArgs>(node: Node, op: K): node is Node & OpArgs[K] {
  return node.op === op;
}
