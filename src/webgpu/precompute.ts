import { CompilationMetadata } from './wgsl-generator';
import { ShaderLayout, BufferBlockLayout } from './shader-layout';
import { DataType, StructDef } from '../ir/types';
import { PrecomputedShaderInfo, PrecomputedInputLayout, PrecomputedWriteOp, PrecomputedResourceInfo } from './host-interface';

export function precomputeShaderInfo(meta: CompilationMetadata, structDefs: StructDef[]): PrecomputedShaderInfo {
  const layout = new ShaderLayout(structDefs);
  const info: PrecomputedShaderInfo = {
    workgroupSize: meta.workgroupSize,
    inputBinding: meta.inputBinding,
    resourceBindings: Array.from(meta.resourceBindings.entries()).map(([id, binding]) => {
      const type = meta.resourceTypes.get(id) || 'buffer';
      return { id, binding, type };
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
  if (['bool'].includes(t)) return { op: 'u32', offset, path };

  if (t.startsWith('vec') || (t.startsWith('float') && !t.includes('x') && !t.includes('[')) || (t.startsWith('int') && t.length <= 4)) {
    const size = helpers.getComponentCount(t);
    const elementType = (t.includes('int') || t.includes('i32')) ? 'i32' : 'f32';
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
    let componentCount = 1;

    if (dataType.includes('int') && !dataType.includes('float')) {
      isInteger = true;
      if (dataType === 'bool') typedArray = 'Uint32Array';
      else typedArray = 'Int32Array';
    }

    if (dataType.includes('2')) componentCount = 2;
    else if (dataType.includes('3')) componentCount = 3;
    else if (dataType.includes('4')) componentCount = 4;
    else if (dataType.includes('mat')) {
      if (dataType.includes('3x3')) componentCount = 9;
      else if (dataType.includes('4x4')) componentCount = 16;
    }

    return {
      type: 'buffer',
      componentCount,
      typedArray,
      isInteger
    };
  }
}
