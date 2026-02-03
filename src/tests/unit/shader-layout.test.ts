import { describe, it, expect } from 'vitest';
import { ShaderLayout, packBuffer } from '../../webgpu/shader-layout';
import { StructDef } from '../../ir/types';

describe('Unit: ShaderLayout', () => {

  describe('Alignment & Size (std140)', () => {
    const layout = new ShaderLayout([]);
    const mode = 'std140';

    it('should handle scalars', () => {
      expect(layout.getSize('float', mode)).toBe(4);
      expect(layout.getAlignment('float', mode)).toBe(4);
      expect(layout.getSize('int', mode)).toBe(4);
      expect(layout.getSize('bool', mode)).toBe(4);
    });

    it('should handle vectors', () => {
      expect(layout.getSize('vec2', mode)).toBe(8);
      expect(layout.getAlignment('vec2', mode)).toBe(8);
      expect(layout.getSize('vec3', mode)).toBe(12);
      expect(layout.getAlignment('vec3', mode)).toBe(16); // vec3 aligns to 16 in std140
      expect(layout.getSize('vec4', mode)).toBe(16);
      expect(layout.getAlignment('vec4', mode)).toBe(16);
    });

    it('should handle matrices', () => {
      // Columns are vec3 or vec4, so align is 16
      expect(layout.getSize('mat3x3', mode)).toBe(48); // 3 * 16
      expect(layout.getAlignment('mat3x3', mode)).toBe(16);
      expect(layout.getSize('mat4x4', mode)).toBe(64); // 4 * 16
      expect(layout.getAlignment('mat4x4', mode)).toBe(16);
    });

    it('should handle arrays (std140 stride rounded to 16)', () => {
      // float array: stride 16 (4 rounded up to 16)
      expect(layout.getSize('array<float, 3>', mode)).toBe(48); // 3 * 16
      expect(layout.getAlignment('array<float, 3>', mode)).toBe(16);
    });
  });

  describe('Alignment & Size (std430)', () => {
    const layout = new ShaderLayout([]);
    const mode = 'std430';

    it('should handle scalars', () => {
      expect(layout.getSize('float', mode)).toBe(4);
      expect(layout.getAlignment('float', mode)).toBe(4);
    });

    it('should handle vectors', () => {
      expect(layout.getSize('vec3', mode)).toBe(12);
      expect(layout.getAlignment('vec3', mode)).toBe(16); // vec3 still aligns to 16 base?
      // Spec: "The base alignment of vec3 is 16". Yes.
    });

    it('should handle arrays (std430 tight packing)', () => {
      // float array: stride 4 (base align of float)
      expect(layout.getSize('array<float, 3>', mode)).toBe(12); // 3 * 4
      expect(layout.getAlignment('array<float, 3>', mode)).toBe(4); // align 4
    });

    it('should handle matrix arrays', () => {
      // array<mat3x3, 2>. mat3x3 stride is 48?
      // "Structure and array members of type matCxR have a stride equal to the base alignment of vecR" - no wait
      // "matrices are stored as arrays of column vectors"
      // std430: "Array stride is the size of the element, rounded up to the base alignment of the element."
      // mat3x3 size is 48. align is 16.
      // So stride is 48.
      expect(layout.getSize('array<mat3x3, 2>', mode)).toBe(96);
    });
  });

  describe('Struct Layouts', () => {
    const structs: StructDef[] = [
      {
        id: 'Inner',
        members: [
          { name: 'val', type: 'float' },     // offset 0, size 4
          { name: 'vec', type: 'float3' }     // offset 16 (align 16), size 12
        ] // Total size: 28 -> round to 16 -> 32
      },
      {
        id: 'Outer',
        members: [
          { name: 'a', type: 'float' },       // offset 0
          { name: 'inner', type: 'Inner' },   // offset 16 (align 16)
          { name: 'b', type: 'float' }        // offset 16+32 = 48
        ] // Total 52 -> round 16 -> 64
      }
    ];
    const layout = new ShaderLayout(structs);

    it('should calculate specific struct layout (std140)', () => {
      const mode = 'std140';
      const inner = layout.getStructLayout('Inner', mode);
      expect(inner.members[0].offset).toBe(0);
      expect(inner.members[1].offset).toBe(16);
      expect(inner.size).toBe(32);
      expect(inner.alignment).toBe(16);

      const outer = layout.getStructLayout('Outer', mode);
      expect(outer.members[0].offset).toBe(0);
      expect(outer.members[1].offset).toBe(16);
      expect(outer.members[2].offset).toBe(48);
      expect(outer.size).toBe(64);
    });

    it('should calculate specific struct layout (std430)', () => {
      // std430 rules for structs are same as std140 typically,
      // unless it affects array strides inside them?
      // Actually spec says "The layout of structures is the same as std140".
      // Only difference is arrays/matrices stride in *blocks*.
      const mode = 'std430';
      const inner = layout.getStructLayout('Inner', mode);
      expect(inner.size).toBe(32);
    });
  });

  describe('Packing (PackBuffer)', () => {
    // Verify matrix packing specifically since that was buggy
    const layout = new ShaderLayout([]);
    const mode = 'std430';

    it('should pack matrices correctly', () => {
      const inputs = [
        { id: 'm3', type: 'float3x3' },
        { id: 'm4', type: 'float4x4' }
      ];
      // Sorts by align (both 16) then ID. m3, m4.
      const block = layout.calculateBlockLayout(inputs, true, mode);

      // m3 at 0. size 48.
      // m4 at 48. size 64.
      // Total 112.

      expect(block.fields[0].name).toBe('m3');
      expect(block.fields[0].offset).toBe(0);
      expect(block.fields[1].name).toBe('m4');
      expect(block.fields[1].offset).toBe(48);
      expect(block.totalSize).toBe(112);

      const m3Data = [1, 0, 0, 0, 2, 0, 0, 0, 3];
      const m4Data = [4, 0, 0, 0, 0, 5, 0, 0, 0, 0, 6, 0, 0, 0, 0, 7];

      const buffer = packBuffer(block, { m3: m3Data, m4: m4Data }, layout, mode);
      const view = new DataView(buffer);

      // Verify m3 diagonal
      expect(view.getFloat32(0, true)).toBe(1);
      // Col 1 (starts at 16). Row 1 (index 1). Offset = 16 + 4 = 20.
      expect(view.getFloat32(20, true)).toBe(2);
      // Col 2 (starts at 32). Row 2 (index 2). Offset = 32 + 8 = 40.
      expect(view.getFloat32(40, true)).toBe(3);

      // Verify m4 diagonal
      // Offset 48 + 0 -> 48
      expect(view.getFloat32(48, true)).toBe(4);
      // Offset 48 + 5*4 (row 1, col 1 in flat? No, col 1 row 1)
      // Col 1 starts at 48 + 16 = 64. Row 1 is +4 = 68.
      // Flat index 5 is col 1 row 1.
      expect(view.getFloat32(48 + 20, true)).toBe(5); // 48 + 1*16 + 1*4 = 68 = 48+20
      expect(view.getFloat32(48 + 40, true)).toBe(6); // 48 + 2*16 + 2*4 = 48+32+8 = 88
      expect(view.getFloat32(48 + 60, true)).toBe(7); // 48 + 3*16 + 3*4 = 48+48+12 = 108
    });

    it('should pack dynamic arrays with no padding (std430)', () => {
      // float[]
      const block = layout.calculateBlockLayout([
        { id: 'arr', type: 'float[]' }
      ], true, mode);

      // offset 0.
      // If we pack 3 floats.
      // std430 float align is 4. Stride is 4.
      // Size = 12.

      const buffer = packBuffer(block, { arr: [1, 2, 3] }, layout, mode);
      expect(buffer.byteLength).toBe(12);
      const view = new DataView(buffer);
      expect(view.getFloat32(0, true)).toBe(1);
      expect(view.getFloat32(4, true)).toBe(2);
      expect(view.getFloat32(8, true)).toBe(3);
    });
  });

});
