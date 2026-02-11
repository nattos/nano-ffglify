
import { describe, it, expect } from 'vitest';
import { validateIR } from '../../ir/validator';
import { IRDocument } from '../../ir/types';

describe('Compliance: Negative Data Type Validation', () => {
  const baseDoc: IRDocument = {
    version: '1.0.0',
    meta: { name: 'Invalid Type Test' },
    entryPoint: 'main',
    inputs: [],
    resources: [],
    structs: [],
    functions: [
      {
        id: 'main',
        type: 'cpu',
        inputs: [],
        outputs: [],
        localVars: [],
        nodes: []
      }
    ]
  };

  it('should explicitly reject invalid buffer dataType', () => {
    const doc = structuredClone(baseDoc);
    doc.resources.push({
      id: 'buf_invalid',
      type: 'buffer',
      dataType: 'vec4<float>', // Invalid
      size: { mode: 'fixed', value: 1 },
      persistence: { retain: false, clearEveryFrame: false, clearOnResize: false, cpuAccess: false }
    } as any);

    const errors = validateIR(doc);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("Buffer resource 'buf_invalid': Invalid data type 'vec4<float>'"),
        severity: 'error'
      })
    ]));
  });

  it('should explicitly reject invalid input dataType', () => {
    const doc = structuredClone(baseDoc);
    doc.inputs.push({
      id: 'in_invalid',
      type: 'some_bad_type' // Invalid
    } as any);

    const errors = validateIR(doc);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("Input 'in_invalid': Invalid data type 'some_bad_type'"),
        severity: 'error'
      })
    ]));
  });

  it('should explicitly reject invalid struct member dataType', () => {
    const doc = structuredClone(baseDoc);
    doc.structs.push({
      id: 'MyStruct',
      members: [
        { name: 'valid_field', type: 'float' },
        { name: 'invalid_field', type: 'matrix4x4' } // Invalid (should be float4x4)
      ]
    });

    const errors = validateIR(doc);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("Struct 'MyStruct' member 'invalid_field': Invalid data type 'matrix4x4'"),
        severity: 'error'
      })
    ]));
  });

  it('should explicitly reject invalid function input dataType', () => {
    const doc = structuredClone(baseDoc);
    doc.functions[0].inputs.push({ id: 'arg0', type: 'double' }); // Invalid

    const errors = validateIR(doc);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("Function 'main' input 'arg0': Invalid data type 'double'"),
        severity: 'error'
      })
    ]));
  });

  it('should explicitly reject invalid function output dataType', () => {
    const doc = structuredClone(baseDoc);
    doc.functions[0].outputs.push({ id: 'res0', type: 'float128' }); // Invalid

    const errors = validateIR(doc);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("Function 'main' output 'res0': Invalid data type 'float128'"),
        severity: 'error'
      })
    ]));
  });

  it('should explicitly reject invalid local variable dataType', () => {
    const doc = structuredClone(baseDoc);
    doc.functions[0].localVars.push({ id: 'v0', type: 'complex64' }); // Invalid

    const errors = validateIR(doc);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("Function 'main' variable 'v0': Invalid data type 'complex64'"),
        severity: 'error'
      })
    ]));
  });

  it('should accept valid primitives and structs', () => {
    const doc = structuredClone(baseDoc);
    doc.structs.push({ id: 'Particle', members: [{ name: 'pos', type: 'float3' }] });

    // Use the struct
    doc.functions[0].localVars.push({ id: 'p', type: 'Particle' });
    doc.functions[0].inputs.push({ id: 'f', type: 'float' });

    const errors = validateIR(doc);
    expect(errors).toEqual([]); // Should be clean (ignoring logic errors like empty function)
  });

  it('should explicitly reject invalid texture wrap mode', () => {
    const doc = structuredClone(baseDoc);
    doc.resources.push({
      id: 'tex_invalid_wrap',
      type: 'texture2d',
      size: { mode: 'fixed', value: [64, 64] },
      sampler: { wrap: 'invalid_wrap' }
    } as any);

    const errors = validateIR(doc);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("Texture resource 'tex_invalid_wrap' has invalid wrap mode 'invalid_wrap'"),
        severity: 'error'
      })
    ]));
  });

  it('should explicitly reject invalid texture filter mode', () => {
    const doc = structuredClone(baseDoc);
    doc.resources.push({
      id: 'tex_invalid_filter',
      type: 'texture2d',
      size: { mode: 'fixed', value: [64, 64] },
      sampler: { filter: 'bicubic' }
    } as any);

    const errors = validateIR(doc);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("Texture resource 'tex_invalid_filter' has invalid filter mode 'bicubic'"),
        severity: 'error'
      })
    ]));
  });
});
