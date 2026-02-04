import { CompilationMetadata } from './wgsl-generator';
import { ShaderLayout, BufferBlockLayout } from './shader-layout';
import { DataType, StructDef } from '../ir/types';
import { PrecomputedShaderInfo, PrecomputedInputLayout, PrecomputedWriteOp, PrecomputedResourceInfo } from './host-interface';

export function precomputeShaderInfo(meta: CompilationMetadata, structDefs: StructDef[]): PrecomputedShaderInfo {
  const layout = new ShaderLayout(structDefs);
  const info: PrecomputedShaderInfo = {
    inputBinding: meta.inputBinding,
    resourceBindings: Array.from(meta.resourceBindings.entries()).map(([id, binding]) => {
      // We need to know if it's a texture or buffer.
      // Meta doesn't explicitly store this, but we can look at the id?
      // Actually, CompilationMetadata has resourceBindings.
      // In WebGpuExecutor, it uses this.resources to check type.
      // For precompute, we might need more context or just assume.
      // Let's assume the caller provides resource types or we derive from usage.
      return { id, binding, type: 'buffer' }; // Default to buffer, caller can override
    })
  };

  if (meta.inputLayout) {
    info.inputLayout = precomputeInputLayout(meta.inputLayout, layout);
  }

  return info;
}

function precomputeInputLayout(layout: BufferBlockLayout, helpers: ShaderLayout): PrecomputedInputLayout {
  const precomputed: PrecomputedInputLayout = {
    totalSize: layout.totalSize,
    hasRuntimeArray: layout.hasRuntimeArray,
    ops: []
  };

  for (const field of layout.fields) {
    if (helpers.isRuntimeArray(field.type)) {
      let inner = 'float';
      const t = field.type.toLowerCase();
      if (t.includes('array<')) inner = t.split('<')[1].split(',')[0].trim();
      else inner = t.split('[')[0].trim();

      const innerSize = helpers.getSize(inner, 'std430');
      const elemAlign = helpers.getAlignment(inner, 'std430');
      const stride = Math.ceil(innerSize / elemAlign) * elemAlign;

      precomputed.runtimeArray = {
        name: field.name!,
        offset: field.offset,
        stride,
        elementType: inner,
        elementOp: generateOp(0, inner, [], helpers)
      };
    } else {
      precomputed.ops.push(generateOp(field.offset, field.type, [field.name!], helpers));
    }
  }

  return precomputed;
}

function generateOp(offset: number, type: string, path: string[], helpers: ShaderLayout): PrecomputedWriteOp {
  const t = type.toLowerCase();

  if (['f32', 'float'].includes(t)) return { op: 'f32', offset, path };
  if (['i32', 'int'].includes(t)) return { op: 'i32', offset, path };
  if (['u32', 'uint', 'bool'].includes(t)) return { op: 'u32', offset, path };

  if (t.startsWith('vec') || (t.startsWith('float') && !t.includes('x') && !t.includes('['))) {
    const size = helpers.getComponentCount(t);
    const elementType = (t.includes('int') || t.includes('i32')) ? 'i32' : (t.includes('uint') || t.includes('u32')) ? 'u32' : 'f32';
    return { op: 'vec', offset, path, size, elementType };
  }

  if (t.includes('mat') || t.includes('x')) {
    const dim = (t.includes('3x3') || t.includes('3')) ? 3 : 4;
    return { op: 'mat', offset, path, dim };
  }

  if (t.includes('[') || t.startsWith('array<')) {
    let inner = 'float';
    let count = 0;
    if (t.startsWith('array<')) {
      const parts = t.substring(6, t.length - 1).split(',');
      inner = parts[0].trim();
      count = parts.length > 1 ? parseInt(parts[1].trim()) : 0;
    } else {
      const parts = t.split('[');
      inner = parts[0].trim();
      count = parseInt(parts[1].split(']')[0]) || 0;
    }

    const innerSize = helpers.getSize(inner, 'std430');
    const elemAlign = helpers.getAlignment(inner, 'std430');
    const stride = Math.ceil(innerSize / elemAlign) * elemAlign;

    return {
      op: 'array',
      offset,
      path,
      length: count,
      stride,
      elementType: inner,
      elementOp: generateOp(0, inner, [], helpers) // Path will be relative in the loop
    };
  }

  // Struct
  const structInfo = helpers.getStructLayout(type, 'std430');
  return {
    op: 'struct',
    offset,
    path,
    members: structInfo.members.map(m => generateOp(m.offset, m.type, [m.name!], helpers))
  };
}

export function precomputeResourceLayout(def: any): PrecomputedResourceInfo {
  if (def.type === 'texture2d') {
    const irFormat = def.format || 'rgba8';
    let format = 'rgba8unorm';
    let typedArray: 'Float32Array' | 'Uint8Array' = 'Uint8Array';
    let componentCount = 4;

    if (irFormat === 'r32f') {
      format = 'r32float';
      typedArray = 'Float32Array';
      componentCount = 1;
    } else if (irFormat === 'rgba32f') {
      format = 'rgba32float';
      typedArray = 'Float32Array';
      componentCount = 4;
    } else if (irFormat === 'rgba16f') {
      format = 'rgba16float';
      typedArray = 'Float32Array'; // Still uses Float32Array on JS side for upload
      componentCount = 4;
    } else if (irFormat === 'r16f') {
      format = 'r16float';
      typedArray = 'Float32Array';
      componentCount = 1;
    } else if (irFormat === 'r8') {
      format = 'r8unorm';
      typedArray = 'Uint8Array';
      componentCount = 1;
    }

    return {
      type: 'texture2d',
      componentCount,
      typedArray,
      format
    };
  } else {
    // Buffer
    const dataType = (def.dataType || 'float').toLowerCase();
    let typedArray: 'Float32Array' | 'Int32Array' | 'Uint32Array' = 'Float32Array';
    let isInteger = false;

    if (dataType.includes('int') && !dataType.includes('float')) {
      isInteger = true;
      if (dataType.includes('uint') || dataType === 'bool') typedArray = 'Uint32Array';
      else typedArray = 'Int32Array';
    }

    return {
      type: 'buffer',
      componentCount: 1, // Buffers are usually base-type arrays
      typedArray,
      isInteger
    };
  }
}
