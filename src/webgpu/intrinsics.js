// Intrinsics
const _applyUnary = (v, f) => Array.isArray(v) ? v.map(f) : f(v);
const _applyBinary = (a, b, f) => {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => f(v, b[i]));
  if (Array.isArray(a)) return a.map(v => f(v, b));
  if (Array.isArray(b)) return b.map(v => f(a, v));
  return f(a, b);
};
const _vec_dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const _vec_length = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const _vec_normalize = (a) => { const l = _vec_length(a); return l < 1e-10 ? a.map(() => 0) : a.map(v => v / l); };
const _mat_mul = (a, b) => {
  if (a.length === 16 || a.length === 9) {
    const dim = a.length === 16 ? 4 : 3;
    if (b.length === a.length) {
      const out = new Array(dim * dim);
      for (let r = 0; r < dim; r++) for (let c = 0; c < dim; c++) {
        let sum = 0; for (let k = 0; k < dim; k++) sum += a[k * dim + r] * b[c * dim + k];
        out[c * dim + r] = sum;
      }
      return out;
    }
    if (b.length === dim) {
      const out = new Array(dim).fill(0);
      for (let r = 0; r < dim; r++) {
        let sum = 0; for (let c = 0; c < dim; c++) sum += a[c * dim + r] * b[c];
        out[r] = sum;
      }
      return out;
    }
  } else if (b.length === 16 || b.length === 9) {
    // Vector * Matrix (Row Vector)
    const dim = b.length === 16 ? 4 : 3;
    if (a.length === dim) {
      const out = new Array(dim).fill(0);
      for (let c = 0; c < dim; c++) {
        let sum = 0; for (let r = 0; r < dim; r++) sum += a[r] * b[c * dim + r];
        out[c] = sum;
      }
      return out;
    }
  }
  return 0;
};
const _quat_mul = (a, b) => {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz
  ];
};
const _quat_slerp = (a, b, t) => {
  let ax = a[0], ay = a[1], az = a[2], aw = a[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;
  if (Math.abs(cosHalfTheta) >= 1.0) return a;
  if (cosHalfTheta < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; cosHalfTheta = -cosHalfTheta; }
  const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);
  if (Math.abs(sinHalfTheta) < 0.001) return [(1 - t) * ax + t * bx, (1 - t) * ay + t * by, (1 - t) * az + t * bz, (1 - t) * aw + t * bw];
  const halfTheta = Math.acos(cosHalfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
  return [ax * ratioA + bx * ratioB, ay * ratioA + by * ratioB, az * ratioA + bz * ratioB, aw * ratioA + bw * ratioB];
};
const _quat_to_mat4 = (q) => {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1
  ];
};
const _getVar = (ctx, id) => {
  if (ctx.inputs.has(id)) return ctx.inputs.get(id);
  throw new Error("Variable '" + id + "' is not defined");
};

const _ensureGpuResource = (device, state) => {
  if (state.def.type === 'texture2d') {
    if (!state.gpuTexture || state.gpuTexture.width !== state.width || state.gpuTexture.height !== state.height) {
      if (state.gpuTexture) state.gpuTexture.destroy();
      state.gpuTexture = device.createTexture({
        size: [state.width, state.height, 1],
        format: 'rgba8unorm', // TODO: support other formats
        usage: 0x1F // RENDER_ATTACHMENT | TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC | COPY_DST
      });
    }

    // Upload data if present
    if (state.data) {
      const w = state.width;
      const h = state.height;
      const format = state.def.format || 'rgba8unorm';

      let data = null;
      let bytesPerRow = 0;

      if (format === 'rgba8' || format === 'rgba8unorm') {
        // Expects 4 components per pixel, 0..1 float in state.data -> 0..255 byte
        const raw = new Uint8Array(w * h * 4);
        const src = state.data;
        // Flatten
        let ptr = 0;
        // src can be flat or mixed? Test uses array of arrays for lines?
        // Test: tex.data = [[r,g,b,a], ...] (Flat list of pixels? No, usually tex.data is flat array or array of pixels)
        // Test uses: [[1,0,0,1], [0,1,0,1]..] which is Array<Array<number>>. Each inner array is a pixel.

        if (Array.isArray(src)) {
          src.forEach(p => {
            if (Array.isArray(p)) {
              raw[ptr++] = p[0] * 255;
              raw[ptr++] = p[1] * 255;
              raw[ptr++] = p[2] * 255;
              raw[ptr++] = p[3] * 255;
            } else {
              raw[ptr++] = p * 255; // scalar? unlikely for rgba8
            }
          });
        }
        data = raw;
        bytesPerRow = w * 4;
      } else if (format === 'r32f') {
        const raw = new Float32Array(w * h);
        const src = state.data;
        let ptr = 0;
        if (Array.isArray(src)) {
          src.forEach(p => {
            if (Array.isArray(p)) raw[ptr++] = p[0];
            else raw[ptr++] = p;
          });
        }
        data = raw;
        bytesPerRow = w * 4;
      }
      // TODO: other formats

      if (data) {
        device.queue.writeTexture(
          { texture: state.gpuTexture },
          data,
          { bytesPerRow },
          { width: w, height: h }
        );
      }
    }
  } else {
    // Buffer
    // Calculate size in bytes. Assumes 4 bytes per element (float/int/uint).
    const byteSize = state.width * 4;
    const alignedSize = Math.max(Math.ceil(byteSize / 4) * 4, 16); // Min 16 for safety

    if (!state.gpuBuffer || state.gpuBuffer.size < alignedSize) {
      if (state.gpuBuffer) state.gpuBuffer.destroy();
      state.gpuBuffer = device.createBuffer({
        size: alignedSize,
        usage: 128 | 8 | 4 // STORAGE | COPY_DST | COPY_SRC
      });
    }
  }
};

const _buffer_store = (resources, id, idx, val) => {
  const res = resources.get(id);
  if (res && res.data) {
    if (idx < 0 || idx >= res.data.length && idx < 100000) {
      // Auto-expand if safe? Or strictly OOB?
      // WebGPU is strict. JS is loose.
      // For JIT, we should probably be compatible with how WebGPU behaves (clamping/ignoring), OR how our test expects it.
      // The error test expects NO error for Type Mismatch? No, the error test expects ERROR for OOB.
    }
    res.data[idx] = val;
    // Invalidate GPU buffer since we modified CPU data
    if (res.gpuBuffer) { res.gpuBuffer.destroy(); res.gpuBuffer = undefined; }
  }
};

const _buffer_load = (resources, id, idx) => {
  const res = resources.get(id);
  // Throw error on OOB to satisfy conformance checks which emulate WGSL strictness or debug behavior
  if (!res || !res.data) throw new Error("Runtime Error: buffer not found");
  if (idx < 0 || idx >= res.data.length) {
    throw new Error("Runtime Error: buffer_load OOB accessing index " + idx + " of size " + res.data.length);
  }
  return res.data[idx];
};

const _createExecutor = (device, pipelines, pipelineMeta, renderPipelines) => {
  return {
    async executeShader(funcId, dim, args, resources) {
      const pipeline = pipelines.get(funcId);
      if (!pipeline) throw new Error("Pipeline not found: " + funcId);
      const meta = pipelineMeta.get(funcId);

      // 2. Resources
      const entries = [];

      // 1. Inputs
      if (meta.inputBinding !== undefined && meta.inputLayout) {
        const layout = meta.inputLayout;
        const structLayouts = meta.structLayouts || {};

        // Helper to get stride/size
        const getStride = (type) => {
          if (structLayouts[type]) return structLayouts[type].size;
          if (type.endsWith('[]')) { // Runtime array
            // Recursive? No, type provided here is usually element type for arrays?
            // No, type is "float[]". Element is "float".
            const elType = type.slice(0, -2);
            return getStride(elType); // Stride of array is its element stride? NO.
            // This function returns stride of A VALUE of this type.
            // Runtime array value... size depends on instance.
            // This shouldn't be called for array type directly for stride calc of array itself.
            return 0;
          }
          if (type.startsWith('array<')) {
            // array<T, N>
            // Element stride?
            // We need to parse T.
            const inner = type.match(/array<(.+),\s*\d+>/);
            if (inner) return getStride(inner[1]) * parseInt(type.match(/,\s*(\d+)>/)[1]); // total size
            return 0; // fallback
          }

          // Primitives (std430 alignment/padding rules apply for stride in array/struct)
          // Stride = max(align, size) generally.
          if (type === 'f32' || type === 'i32' || type === 'u32' || type === 'float' || type === 'int' || type === 'uint' || type === 'bool') return 4;
          if (type.startsWith('vec2')) return 8; // 8 bytes
          if (type.startsWith('vec3')) return 16; // 16 bytes (padded)
          if (type.startsWith('vec4')) return 16;
          if (type.startsWith('mat2x2')) return 16; // 2 * 8 ? No col align is 8? std430: col vectors are scalar arrays?
          // std430: matrix columns are aligned to component type? No.
          // mat2x2<f32>: 2 vec2<f32>. vec2 align 8. stride 8. Total 16.
          if (type.startsWith('mat3x3')) return 48; // 3 * 16 (vec3 aligned to 16)
          if (type.startsWith('mat4x4')) return 64; // 4 * 16
          return 0;
        };

        const getElementStride = (type) => {
          // For array<T>, what is stride of T?
          // It is generally getStride(T) but padded to alignment of T.
          // In std430, align is base alignment.
          // Conveniently, our getStride mostly returns 16 for vec3 etc.
          // Let's refine specific cases.
          let elType = type;
          if (type.endsWith('[]')) elType = type.slice(0, -2);
          else if (type.startsWith('array<')) {
            const m = type.match(/array<(.+)(?:,\s*\d+)?>/);
            if (m) elType = m[1];
          }

          // Now get stride of elType
          if (structLayouts[elType]) return structLayouts[elType].size; // Struct size is already padded to alignment

          if (elType === 'f32' || elType === 'float' || elType === 'i32' || elType === 'int' || elType === 'u32' || elType === 'uint' || elType === 'bool') return 4;
          if (elType.startsWith('vec2')) return 8;
          if (elType.startsWith('vec3')) return 16; // vec3 is 16-byte strided in arrays
          if (elType.startsWith('vec4')) return 16;
          if (elType.startsWith('mat3x3')) return 48; // matrix array stride = matrix size
          if (elType.startsWith('mat4x4')) return 64;
          // ...
          return 4; // default
        };

        // Calculate Dynamic Size
        let requiredSize = layout.totalSize;
        const inputs = { ...args, u_dispatch_size: dim };

        if (layout.hasRuntimeArray) {
          const lastField = layout.fields[layout.fields.length - 1]; // Assuming sorted?
          // The last field in layout should be the runtime array.
          // We need to check inputs for it.
          const arr = inputs[lastField.name];
          if (Array.isArray(arr)) {
            // Calculate size
            const stride = getElementStride(lastField.type);
            requiredSize = lastField.offset + arr.length * stride;
          }
        }

        // Re-align to 4?
        requiredSize = Math.ceil(requiredSize / 4) * 4;

        const buffer = new ArrayBuffer(requiredSize);
        const view = new DataView(buffer);

        const writeField = (offset, val, type) => {
          const t = type.toLowerCase();
          if (val === undefined || val === null) return;

          if (structLayouts[type]) {
            // It's a struct
            const sLayout = structLayouts[type];
            sLayout.members.forEach(m => {
              if (val[m.name] !== undefined) {
                writeField(offset + m.offset, val[m.name], m.type);
              }
            });
          } else if (Array.isArray(val)) {
            // Vector, Matrix, or Array
            if (t.startsWith('vec')) {
              const isInt = t.includes('i32') || t.includes('int');
              const isUint = t.includes('u32') || t.includes('uint');
              for (let i = 0; i < val.length; i++) {
                if (isInt) view.setInt32(offset + i * 4, val[i], true);
                else if (isUint) view.setUint32(offset + i * 4, val[i], true);
                else view.setFloat32(offset + i * 4, val[i], true);
              }
            } else if (t.startsWith('mat') || t.startsWith('float3x3') || t.startsWith('float4x4')) {
              const dim = t.includes('3') ? 3 : 4; // cols
              // Rows? logic assumed square or floatN
              // WebGPU matrices are Column-Major. val is likely [c0r0, c0r1, ..., c1r0...] flat array?
              // If val is flat array of 9 or 16 numbers.
              // Matrix stride in array/struct:
              // mat3x3: 3 vec3s. Each vec3 is 16 bytes (padded).
              // We need to write column by column, respecting padding.
              const rows = dim;
              const colStride = dim === 3 ? 16 : (dim * 4);

              for (let c = 0; c < dim; c++) {
                const colOffset = offset + c * colStride;
                for (let r = 0; r < rows; r++) {
                  view.setFloat32(colOffset + r * 4, val[c * rows + r], true);
                }
              }
            } else {
              // Array (Fixed or Runtime)
              const stride = getElementStride(type);
              // Determine element type name
              let elType = type;
              if (type.endsWith('[]')) elType = type.slice(0, -2);
              else {
                const m = type.match(/array<(.+)(?:,\s*\d+)?>/);
                if (m) elType = m[1];
              }

              val.forEach((item, idx) => {
                writeField(offset + idx * stride, item, elType);
              });
            }
          } else if (typeof val === 'number') {
            if (t.includes('i32') || t.includes('int')) view.setInt32(offset, val, true);
            else if (t.includes('u32') || t.includes('uint') || t === 'bool') view.setUint32(offset, typeof val === 'boolean' ? (val ? 1 : 0) : val, true);
            else view.setFloat32(offset, val, true);
          } else if (typeof val === 'boolean') {
            view.setUint32(offset, val ? 1 : 0, true);
          }
        };

        layout.fields.forEach(f => {
          if (inputs[f.name] !== undefined) {
            writeField(f.offset, inputs[f.name], f.type);
          }
        });

        const inputBuf = device.createBuffer({
          size: requiredSize,
          usage: 128 | 8 // STORAGE | COPY_DST
        });
        device.queue.writeBuffer(inputBuf, 0, buffer);
        entries.push({ binding: meta.inputBinding, resource: { buffer: inputBuf } });
      }

      // Resource logic continues...
      // Flatten resource bindings
      for (const [resId, binding] of Object.entries(meta.resourceBindings)) {
        const state = resources.get(resId);
        if (!state) continue;

        // Ensure GPU resource exists (Helper in intrinsics)
        _ensureGpuResource(device, state);

        if (state.def.type === 'texture2d') {
          entries.push({ binding, resource: state.gpuTexture.createView() });
        } else {
          entries.push({ binding, resource: { buffer: state.gpuBuffer } });
        }
      }

      // If inputs, bind them (TODO)

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(dim[0], dim[1], dim[2]);
      pass.end();
      device.queue.submit([encoder.finish()]);

      // Synchronization / Readback
      // Only if needed (e.g. for tests). In production this should be explicit or optimized.
      // Actually user code might rely on it if doing CPU readback.
      const readbackEncoder = device.createCommandEncoder();
      const stagingBuffers = [];
      let needsReadback = false;

      for (const [resId, binding] of Object.entries(meta.resourceBindings)) {
        const state = resources.get(resId);
        if (!state || !state.gpuBuffer) continue;

        if (state.def.type === 'buffer') {
          const size = state.gpuBuffer.size;
          const staging = device.createBuffer({
            size: size,
            usage: 1 | 8 // MAP_READ | COPY_DST
          });
          readbackEncoder.copyBufferToBuffer(state.gpuBuffer, 0, staging, 0, size);
          stagingBuffers.push({ state, staging });
          needsReadback = true;
        }
      }

      if (needsReadback) {
        device.queue.submit([readbackEncoder.finish()]);
        await Promise.all(stagingBuffers.map(async ({ state, staging }) => {
          await staging.mapAsync(1); // READ
          const range = staging.getMappedRange();
          const data = new Float32Array(range);

          // Restructure data based on type
          const type = state.def.dataType || 'float';
          const flat = Array.from(data);
          let structured = flat;

          if (type === 'float4' || type === 'vec4') {
            structured = [];
            for (let i = 0; i < state.width; i++) structured.push(flat.slice(i * 4, i * 4 + 4));
          } else if (type === 'float3' || type === 'vec3') {
            structured = [];
            for (let i = 0; i < state.width; i++) structured.push(flat.slice(i * 4, i * 4 + 3));
          } else if (type === 'float2' || type === 'vec2') {
            structured = [];
            for (let i = 0; i < state.width; i++) structured.push(flat.slice(i * 2, i * 2 + 2));
          } else {
            structured = flat.slice(0, state.width);
          }

          state.data = structured;
          staging.unmap();
          staging.destroy();
        }));
      }
    },

    async executeDraw(targetId, vertexId, fragmentId, count, pipelineDef, resources) {
      const key = `${vertexId}|${fragmentId}`;
      const pipeline = renderPipelines.get(key);
      // ... implementation similar to webgpu-executor ...
    }
  };
};
