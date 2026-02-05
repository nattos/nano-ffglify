import { DataType, StructDef, ResourceDef } from '../ir/types';
import { RuntimeValue } from './host-interface';

/**
 * Represents the memory layout of a single field within a struct or buffer.
 */
export interface FieldLayout {
  name?: string;
  type: DataType;
  offset: number; // Byte offset relative to container
  size: number; // Size in bytes
  align: number; // Alignment requirement
}

export interface StructLayoutInfo {
  size: number;
  alignment: number;
  members: FieldLayout[];
}

/**
 * Represents the layout of a complete uniform/storage buffer block.
 */
export interface BufferBlockLayout {
  fields: FieldLayout[];
  totalSize: number; // Static size (excluding runtime array dependent part)
  alignment: number; // Base alignment
  hasRuntimeArray: boolean; // True if the last field is a runtime array
}

/**
 * Defines the interface (bindings) for a shader or pipeline.
 */
export class ShaderInterfaceDefinition {
  public resourceBindings = new Map<string, number>();
  public bindGroupLayouts: GPUBindGroupLayoutEntry[] = [];
  public inputLayout?: BufferBlockLayout;

  public static create(
    resources: ResourceDef[],
    usedResources: Set<string>,
    inputs: { id: string, type: DataType }[],
    layoutHelpers: ShaderLayout,
    hasGlobalInputs: boolean
  ): ShaderInterfaceDefinition {
    const def = new ShaderInterfaceDefinition();
    let bindingIdx = 0;

    const sortedResources = [...resources].filter(r => usedResources.has(r.id)).sort((a, b) => a.id.localeCompare(b.id));

    for (const res of sortedResources) {
      def.resourceBindings.set(res.id, bindingIdx++);
    }

    if (hasGlobalInputs && inputs.length > 0) {
      def.inputLayout = layoutHelpers.calculateBlockLayout(inputs, true);
    }

    return def;
  }
}

/**
 * Handles std140 layout rules.
 */
export class ShaderLayout {
  private structs: Map<string, StructDef>;
  private structLayoutCache = new Map<string, StructLayoutInfo>();

  constructor(structs: StructDef[]) {
    this.structs = new Map(structs.map(s => [s.id.toLowerCase(), s]));
  }

  public calculateBlockLayout(inputs: { id: string, type: DataType }[], sort: boolean = true, mode: 'std140' | 'std430' = 'std430'): BufferBlockLayout {
    let sorted = [...inputs];

    // Sort logic remains valid for packing efficiency, but std430 allows tighter packing
    if (sort) {
      sorted.sort((a, b) => {
        const aIsRuntime = this.isRuntimeArray(a.type);
        const bIsRuntime = this.isRuntimeArray(b.type);
        if (aIsRuntime && !bIsRuntime) return 1;
        if (!aIsRuntime && bIsRuntime) return -1;

        const alignDiff = this.getAlignment(b.type, mode) - this.getAlignment(a.type, mode);
        if (alignDiff !== 0) return alignDiff;

        return a.id.localeCompare(b.id);
      });
    }

    let offset = 0;
    let maxAlign = 16;
    const fields: FieldLayout[] = [];

    for (const input of sorted) {
      const align = this.getAlignment(input.type, mode);
      const size = this.getSize(input.type, mode);

      offset = Math.ceil(offset / align) * align;

      fields.push({
        name: input.id,
        type: input.type,
        offset,
        size,
        align
      });

      offset += size;
      maxAlign = Math.max(maxAlign, align);
    }

    const totalSize = Math.ceil(offset / maxAlign) * maxAlign;
    const hasRuntimeArray = sorted.length > 0 && this.isRuntimeArray(sorted[sorted.length - 1].type);

    return {
      fields,
      totalSize: Math.max(16, totalSize),
      alignment: maxAlign,
      hasRuntimeArray
    };
  }

  public getStructLayout(type: string, mode: 'std140' | 'std430' = 'std430'): StructLayoutInfo {
    const key = type.toLowerCase();
    const cacheKey = `${key}:${mode}`;
    if (this.structLayoutCache.has(cacheKey)) return this.structLayoutCache.get(cacheKey)!;

    const s = this.structs.get(key);
    if (!s) return { size: 0, alignment: 16, members: [] };

    let offset = 0;
    let maxAlign = mode === 'std140' ? 16 : 0; // std140 force 16 min, std430 based on members
    const members: FieldLayout[] = [];

    for (const m of s.members) {
      const align = this.getAlignment(m.type, mode);
      const size = this.getSize(m.type, mode);

      offset = Math.ceil(offset / align) * align;
      members.push({
        name: m.name,
        type: m.type,
        offset,
        size,
        align
      });
      offset += size;
      maxAlign = Math.max(maxAlign, align);
    }

    const size = Math.ceil(offset / maxAlign) * maxAlign;
    const info = { size, alignment: maxAlign, members };
    this.structLayoutCache.set(cacheKey, info);
    return info;
  }

  public getAlignment(type: DataType, mode: 'std140' | 'std430' = 'std430'): number {
    const t = type.toLowerCase();

    if (['f32', 'i32', 'u32', 'float', 'int', 'bool', 'uint'].some(x => t === x)) return 4;

    // Matrices (array of columns)
    if (t.startsWith('mat') || (t.startsWith('float') && t.includes('x'))) return 16;

    if (['vec2', 'float2'].some(x => t.includes(x))) return 8;
    if (['vec3', 'vec4', 'float3', 'float4', 'quat'].some(x => t.includes(x))) return 16;

    if (t.endsWith(']') || t.startsWith('array<')) {
      if (mode === 'std140') return 16;
      // std430: base alignment of element
      let inner = 'float';
      if (t.startsWith('array<')) {
        inner = t.substring(6, t.length - 1).split(',')[0].trim();
      } else {
        inner = t.substring(0, t.indexOf('['));
      }
      return this.getAlignment(inner, mode);
    }

    const s = this.structs.get(t);
    if (s) {
      // Struct alignment
      const layout = this.getStructLayout(type, mode);
      if (mode === 'std140') return Math.ceil(layout.alignment / 16) * 16;
      return layout.alignment;
    }

    return 16;
  }

  public getSize(type: DataType, mode: 'std140' | 'std430' = 'std430'): number {
    const t = type.toLowerCase();

    if (['f32', 'i32', 'u32', 'float', 'int', 'bool', 'uint'].some(x => t === x)) return 4;

    if (t.endsWith(']') || t.startsWith('array<')) {
      let inner = 'float';
      let count = 0;
      if (t.startsWith('array<')) {
        const parts = t.substring(6, t.length - 1).split(',');
        inner = parts[0].trim();
        count = parts.length > 1 ? parseInt(parts[1].trim()) : 0;
      } else {
        inner = t.substring(0, t.indexOf('['));
      }

      const elemSize = this.getSize(inner, mode);
      const elemAlign = this.getAlignment(inner, mode);
      // std140 stride: round to 16. std430 stride: round to align.
      const stride = Math.ceil(elemSize / (mode === 'std140' ? 16 : elemAlign)) * (mode === 'std140' ? 16 : elemAlign);

      return count * stride;
    }

    if (t.includes('mat3') || t.includes('float3x3')) return 48; // 3 * 16 (std140/std430 same for matrix columns?) yes columns 16-align
    if (t.includes('mat4') || t.includes('float4x4')) return 64;

    if (['vec2', 'float2'].some(x => t.includes(x))) return 8;
    if (['vec3', 'float3'].some(x => t.includes(x))) return 12;
    if (['vec4', 'float4', 'quat'].some(x => t.includes(x))) return 16;

    const s = this.structs.get(t);
    if (s) return this.getStructLayout(type, mode).size;

    return 16;
  }

  public isRuntimeArray(type: string): boolean {
    const t = type.toLowerCase();
    if (t.includes('[]')) return true;
    if (t.startsWith('array<') && !t.includes(',')) return true;
    return false;
  }

  public getComponentCount(type: string): number {
    const t = type.toLowerCase();
    if (t.includes('float4') || t === 'quat' || t.includes('vec4')) return 4;
    if (t.includes('float3') || t.includes('vec3')) return 3;
    if (t.includes('float2') || t.includes('vec2')) return 2;
    if (t.includes('mat4')) return 16;
    if (t.includes('mat3')) return 9;

    if (t.includes('[') || t.startsWith('array<')) return 1;
    return 1;
  }
}

/**
 * Packs runtime values into an ArrayBuffer based on a layout.
 */
export function packBuffer(layout: BufferBlockLayout, values: Record<string, RuntimeValue>, layoutHelpers: ShaderLayout, mode: 'std140' | 'std430' = 'std430'): ArrayBuffer {
  // 1. Calculate dynamic size if needed
  let bufferSize = layout.totalSize;
  const lastField = layout.fields[layout.fields.length - 1];

  if (layout.hasRuntimeArray && lastField) {
    const val = values[lastField.name!];
    if (Array.isArray(val)) {
      // Calculate size of array payload
      let inner = 'float';
      const t = lastField.type;
      if (t.includes('array<')) inner = t.split('<')[1].split(',')[0].trim();
      else inner = t.split('[')[0].trim();

      const innerSize = layoutHelpers.getSize(inner, mode);
      const elemAlign = layoutHelpers.getAlignment(inner, mode);
      const stride = Math.ceil(innerSize / (mode === 'std140' ? 16 : elemAlign)) * (mode === 'std140' ? 16 : elemAlign);

      const arraySize = val.length * stride;
      // CAREFUL: layout.totalSize includes padding for the block alignment.
      // But 'lastField' (runtime array) starts at lastField.offset and occupies arraySize.
      // We should ignore the padded totalSize and just use offset + arraySize.
      // However, we satisfy min buffer size if needed.
      bufferSize = lastField.offset + arraySize;
    }
  }

  // console.log(`[packBuffer] Layout total: ${layout.totalSize}, Buffer Size: ${bufferSize}`);

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);
  // console.log(`[packBuffer] Created DataView. ByteLength: ${view.byteLength}`);

  for (const field of layout.fields) {
    const val = values[field.name!];
    if (val === undefined) {
      // console.warn(`[packBuffer] Missing value for field ${field.name}`);
      continue;
    }
    // console.log(`[packBuffer] Writing ${field.name} (${field.type}) at ${field.offset}:`, val);
    try {
      writeFieldRecursive(view, field.offset, val, field.type, layoutHelpers, mode);
    } catch (e) {
      // console.error(`[packBuffer] Error writing ${field.name} at ${field.offset}:`, e);
      throw e;
    }
  }

  return buffer;
}

function writeFieldRecursive(view: DataView, offset: number, val: RuntimeValue, type: string, layout: ShaderLayout, mode: 'std140' | 'std430') {
  const t = type.toLowerCase();

  // console.log(`  [writeField] Off: ${offset} Type: ${type} Val:`, val);

  if (typeof val === 'number') {
    if (t.includes('int') && !t.includes('u')) view.setInt32(offset, val, true);
    else if (t.includes('uint') || t.includes('u32') || t === 'bool') view.setUint32(offset, typeof val === 'boolean' ? (val ? 1 : 0) : val as number, true);
    else view.setFloat32(offset, val, true);
  } else if (typeof val === 'boolean') {
    view.setUint32(offset, val ? 1 : 0, true);
  } else if (Array.isArray(val)) {
    if ((t.startsWith('vec') || t.startsWith('float')) && !t.includes('x') && !t.includes('[')) {
      // Vector
      const isInt = t.includes('int') || t.includes('i32');
      const isUint = t.includes('uint') || t.includes('u32');
      for (let i = 0; i < val.length; i++) {
        if (isInt) view.setInt32(offset + i * 4, val[i] as number, true);
        else if (isUint) view.setUint32(offset + i * 4, val[i] as number, true);
        else view.setFloat32(offset + i * 4, val[i] as number, true);
      }
    } else if (t.includes('mat') || t.includes('x')) {
      // Matrix
      const dim = (t.includes('3x3') || t.includes('3')) ? 3 : 4;
      for (let c = 0; c < dim; c++) {
        const colOffset = offset + c * 16;
        for (let r = 0; r < dim; r++) {
          view.setFloat32(colOffset + r * 4, val[c * dim + r] as number, true);
        }
      }
    } else {
      // Array
      let inner = 'float';
      if (t.includes('array<')) inner = t.split('<')[1].split(',')[0].trim();
      else inner = t.split('[')[0].trim();

      const innerSize = layout.getSize(inner, mode);
      const elemAlign = layout.getAlignment(inner, mode);
      const stride = Math.ceil(innerSize / (mode === 'std140' ? 16 : elemAlign)) * (mode === 'std140' ? 16 : elemAlign);

      for (let i = 0; i < val.length; i++) {
        writeFieldRecursive(view, offset + i * stride, val[i] as any, inner, layout, mode);
      }
    }
  } else if (typeof val === 'object' && val !== null) {
    // Structure
    const structInfo = layout.getStructLayout(type, mode);
    for (const member of structInfo.members) {
      if (member.name && (val as any)[member.name] !== undefined) {
        writeFieldRecursive(view, offset + member.offset, (val as any)[member.name], member.type, layout, mode);
      }
    }
  }
}
