import { IRDocument } from "../domain/types";
import { TextureFormat } from "../ir/types";
import { ResourceState } from "../webgpu/host-interface";

export function makeResourceStates(ir: IRDocument): Map<string, ResourceState> {
  const resources = new Map<string, ResourceState>();

  // Initialize Resources (default state)
  for (const res of ir.resources) {
    let width = 1;
    let height = 1;

    if (res.size.mode === 'fixed') {
      const val = res.size.value;
      if (Array.isArray(val)) {
        width = val[0];
        height = val[1];
      } else {
        width = val;
      }
    }

    resources.set(res.id, {
      def: {
        ...res,
        size: res.size,
        format: res.format ?? TextureFormat.RGBA8 // Default texture format
      },
      width,
      height,
      data: [] // Data initialized lazily or on resize
    });

    // Apply clearVal if present
    if (res.persistence.clearValue !== undefined) {
      const r = resources.get(res.id)!;
      const count = width * height;
      r.data = new Array(count).fill(res.persistence.clearValue);
    }
  }

  // Treat 'texture2d' Inputs as Resources
  for (const inp of ir.inputs) {
    if (inp.type === 'texture2d') {
      resources.set(inp.id, {
        def: {
          id: inp.id,
          type: 'texture2d',
          persistence: {
            retain: false,
            clearOnResize: false,
            clearEveryFrame: false,
            cpuAccess: false
          },
        },
        width: 1,
        height: 1
      });
    }
  }

  return resources;
}