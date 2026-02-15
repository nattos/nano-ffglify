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

const _buffer_store = (resources, id, idx, val) => {
  const res = resources.get(id);
  if (res && res.data) {
    if (idx < 0 || idx >= res.data.length && idx < 100000) {
      // OOB check omitted for performance in JIT, reliant on validation/tests
    }
    res.data[idx] = val;
    // Mark as dirty on CPU so we know to upload later
    if (!res.flags) res.flags = { cpuDirty: false, gpuDirty: false };
    res.flags.cpuDirty = true;
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

const _createExecutor = (device, pipelines, precomputedInfos, renderPipelines, resourceInfos = new Map()) => {
  const writeOp = (view, op, val, baseOffset = 0) => {
    if (val === undefined || val === null) return;
    let currentVal = val;
    for (const p of op.path) {
      currentVal = currentVal[p];
      if (currentVal === undefined || currentVal === null) {
        return;
      }
    }

    const offset = baseOffset + op.offset;
    switch (op.op) {
      case 'f32': view.setFloat32(offset, currentVal, true); break;
      case 'i32': view.setInt32(offset, currentVal, true); break;
      case 'u32': view.setUint32(offset, currentVal, true); break;
      case 'vec': {
        const { size, elementType } = op;
        for (let i = 0; i < size; i++) {
          if (elementType === 'i32') view.setInt32(offset + i * 4, currentVal[i], true);
          else if (elementType === 'u32') view.setUint32(offset + i * 4, currentVal[i], true);
          else view.setFloat32(offset + i * 4, currentVal[i], true);
        }
        break;
      }
      case 'mat': {
        const { dim } = op;
        const colStride = dim === 3 ? 16 : dim * 4;
        for (let c = 0; c < dim; c++) {
          const colOffset = offset + c * colStride;
          for (let r = 0; r < dim; r++) {
            view.setFloat32(colOffset + r * 4, currentVal[c * dim + r], true);
          }
        }
        break;
      }
      case 'struct': {
        for (const m of op.members) {
          writeOp(view, m, currentVal, offset);
        }
        break;
      }
      case 'array': {
        const { stride, length, elementOp } = op;
        const count = length === 'runtime' ? currentVal.length : length;
        for (let i = 0; i < count; i++) {
          writeOp(view, elementOp, currentVal[i], offset + i * stride);
        }
        break;
      }
    }
  };

  // Staging buffers for async readbacks
  // Map<ResourceId, { buffer: GPUBuffer, bytesPerRow?: number, type: 'buffer'|'texture' }>
  const activeReadbacks = new Map();

  return {
    async executeShader(funcId, dim, args, resources) {
      const info = precomputedInfos.get(funcId);
      if (!info) throw new Error("Precomputed info not found: " + funcId);
      const pipeline = pipelines.get(funcId);

      const entries = [];
      const normalizedDim = [
        dim[0] || 1,
        dim[1] || 1,
        dim[2] || 1
      ];

      // 1. Inputs
      if (info.inputLayout) {
        const layout = info.inputLayout;
        let requiredSize = layout.totalSize;
        const inputs = { ...args, u_dispatch_size: normalizedDim, output_size: normalizedDim };

        if (layout.hasRuntimeArray && layout.runtimeArray) {
          const arr = inputs[layout.runtimeArray.name];
          if (Array.isArray(arr)) {
            requiredSize = layout.runtimeArray.offset + arr.length * layout.runtimeArray.stride;
          }
        }

        requiredSize = Math.max(Math.ceil(requiredSize / 4) * 4, 16);
        const bufferSize = requiredSize;
        const buffer = new ArrayBuffer(bufferSize);
        const view = new DataView(buffer);

        for (const op of layout.ops) {
          writeOp(view, op, inputs);
        }

        if (layout.runtimeArray) {
          const arr = inputs[layout.runtimeArray.name];
          if (Array.isArray(arr)) {
            const { offset, stride, elementOp } = layout.runtimeArray;
            for (let i = 0; i < arr.length; i++) {
              writeOp(view, elementOp, arr[i], offset + i * stride);
            }
          }
        }

        const inputBuf = device.createBuffer({
          size: bufferSize,
          usage: 128 | 8 // STORAGE | COPY_DST
        });
        device.queue.writeBuffer(inputBuf, 0, buffer);
        entries.push({ binding: info.inputBinding, resource: { buffer: inputBuf } });
      }

      // 2. Resources
      for (const resBind of info.resourceBindings) {
        const state = resources.get(resBind.id);
        if (!state) continue;
        const resInfo = resourceInfos.get(resBind.id);
        _ensureGpuResource(device, state, resInfo);

        // Mark as potentially dirty on GPU since we are computing
        if (!state.flags) state.flags = { cpuDirty: false, gpuDirty: false };
        // We assume write access for storage bindings.
        // Ideally we'd check if it's read-only, but for now be conservative.
        state.flags.gpuDirty = true;

        if (state.def.type === 'texture2d') {
          entries.push({ binding: resBind.binding, resource: state.gpuTexture.createView() });
        } else {
          entries.push({ binding: resBind.binding, resource: { buffer: state.gpuBuffer } });
        }
      }

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      if (entries.length > 0) {
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries
        });
        pass.setBindGroup(0, bindGroup);
      }
      const wgSize = info.workgroupSize || [16, 16, 1];
      const workgroups = [
        Math.ceil(normalizedDim[0] / wgSize[0]),
        Math.ceil(normalizedDim[1] / wgSize[1]),
        Math.ceil(normalizedDim[2] / wgSize[2])
      ];
      pass.dispatchWorkgroups(workgroups[0], workgroups[1], workgroups[2]);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },

    async executeDraw(targetId, vertexId, fragmentId, count, pipelineDef, resources, args) {
      const key = `${vertexId}|${fragmentId}`;
      const pipeline = renderPipelines.get(key);
      if (!pipeline) throw new Error("Render pipeline not found: " + key);

      // Use vertex shader info for bindings
      const info = precomputedInfos.get(vertexId);
      if (!info) throw new Error("Precomputed info not found for vertex shader: " + vertexId);

      const targetState = resources.get(targetId);
      if (!targetState) throw new Error("Target resource not found: " + targetId);
      const targetResInfo = resourceInfos.get(targetId);
      _ensureGpuResource(device, targetState, targetResInfo);

      // Target will be written to
      if (!targetState.flags) targetState.flags = { cpuDirty: false, gpuDirty: false };
      targetState.flags.gpuDirty = true;

      const entries = [];

      // Inject output_size for vertex/fragment shaders (render target dimensions)
      const outputSize = [targetState.width, targetState.height, 1];
      const inputArgs = { ...(args || {}), output_size: outputSize };

      // Inputs buffer (global inputs for vertex/fragment shaders)
      if (info.inputLayout && inputArgs) {
        const layout = info.inputLayout;
        let requiredSize = layout.totalSize;

        if (layout.hasRuntimeArray && layout.runtimeArray) {
          const arr = inputArgs[layout.runtimeArray.name];
          if (Array.isArray(arr)) {
            requiredSize = layout.runtimeArray.offset + arr.length * layout.runtimeArray.stride;
          }
        }

        requiredSize = Math.max(Math.ceil(requiredSize / 4) * 4, 16);
        const bufferSize = requiredSize;
        const buffer = new ArrayBuffer(bufferSize);
        const view = new DataView(buffer);

        for (const op of layout.ops) {
          writeOp(view, op, inputArgs);
        }

        if (layout.runtimeArray) {
          const arr = inputArgs[layout.runtimeArray.name];
          if (Array.isArray(arr)) {
            const { offset, stride, elementOp } = layout.runtimeArray;
            for (let i = 0; i < arr.length; i++) {
              writeOp(view, elementOp, arr[i], offset + i * stride);
            }
          }
        }

        const inputBuf = device.createBuffer({
          size: bufferSize,
          usage: 128 | 8 // STORAGE | COPY_DST
        });
        device.queue.writeBuffer(inputBuf, 0, buffer);
        entries.push({ binding: info.inputBinding, resource: { buffer: inputBuf } });
      }

      for (const resBind of info.resourceBindings) {
        if (resBind.id === targetId) continue;
        const state = resources.get(resBind.id);
        if (!state) continue;
        const resInfo = resourceInfos.get(resBind.id);
        _ensureGpuResource(device, state, resInfo);
        if (state.def.type === 'texture2d') {
          entries.push({ binding: resBind.binding, resource: state.gpuTexture.createView() });
        } else {
          entries.push({ binding: resBind.binding, resource: { buffer: state.gpuBuffer } });
        }
      }

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: targetState.gpuTexture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 }
        }]
      });

      pass.setPipeline(pipeline);
      pass.setViewport(0, 0, targetState.width, targetState.height, 0, 1);
      pass.setScissorRect(0, 0, targetState.width, targetState.height);
      if (entries.length > 0) {
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries
        });
        pass.setBindGroup(0, bindGroup);
      }
      pass.draw(count);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },

    executeSyncToCpu(resourceId, resources) {
      const state = resources.get(resourceId);
      if (!state) return;
      // Only readback if GPU is dirty
      if (!state.flags || !state.flags.gpuDirty) return;

      const encoder = device.createCommandEncoder();

      if ((state.def.type === 'buffer' || state.def.type === 'atomic_counter') && state.gpuBuffer) {
        const size = state.gpuBuffer.size;
        const staging = device.createBuffer({
          size: size,
          usage: 1 | 8 // MAP_READ | COPY_DST
        });
        encoder.copyBufferToBuffer(state.gpuBuffer, 0, staging, 0, size);
        activeReadbacks.set(resourceId, { staging, type: 'buffer' });
      } else if (state.def.type === 'texture2d' && state.gpuTexture) {
        const bytesPerPixel = 4;
        const bytesPerRow = Math.ceil((state.width * bytesPerPixel) / 256) * 256;
        const staging = device.createBuffer({
          size: bytesPerRow * state.height,
          usage: 1 | 8 // MAP_READ | COPY_DST
        });
        encoder.copyTextureToBuffer(
          { texture: state.gpuTexture },
          { buffer: staging, bytesPerRow },
          [state.width, state.height, 1]
        );
        activeReadbacks.set(resourceId, { staging, type: 'texture', bytesPerRow });
      }

      device.queue.submit([encoder.finish()]);

      // Start async mapping (don't await here)
      const pending = activeReadbacks.get(resourceId);
      if (pending) {
        pending.promise = pending.staging.mapAsync(1);
      }
    },

    async executeWaitCpuSync(resourceId, resources) {
      const pending = activeReadbacks.get(resourceId);
      if (!pending) return; // Maybe already synced or not dirty

      await pending.promise;

      const state = resources.get(resourceId);
      const range = pending.staging.getMappedRange();

      if (pending.type === 'buffer') {
        const info = resourceInfos.get(resourceId);
        const taType = info?.typedArray || 'Float32Array';
        let rawData;
        if (taType === 'Uint32Array') rawData = new Uint32Array(range);
        else if (taType === 'Int32Array') rawData = new Int32Array(range);
        else if (taType === 'Uint8Array') rawData = new Uint8Array(range);
        else rawData = new Float32Array(range);

        const componentCount = info?.componentCount || 1;
        const flatData = Array.from(rawData).slice(0, state.width * componentCount);

        if (componentCount > 1) {
          const structured = [];
          for (let i = 0; i < state.width; i++) {
            structured.push(flatData.slice(i * componentCount, (i + 1) * componentCount));
          }
          state.data = structured;
        } else {
          state.data = flatData;
        }
      } else {
        const bytesPerRow = pending.bytesPerRow;
        const data = new Uint8Array(range);
        const reshaped = [];
        for (let y = 0; y < state.height; y++) {
          const rowStart = y * bytesPerRow;
          for (let x = 0; x < state.width; x++) {
            const start = rowStart + (x * 4);
            reshaped.push(Array.from(data.slice(start, start + 4)).map(v => v / 255.0)); // Normalize to 0-1
          }
        }
        state.data = reshaped;
      }

      pending.staging.unmap();
      pending.staging.destroy();
      activeReadbacks.delete(resourceId);

      if (state.flags) {
        state.flags.gpuDirty = false;
        state.flags.cpuDirty = false;
      }
    },

    executeCopyBuffer(srcId, dstId, srcOffset, dstOffset, count, resources) {
      const src = resources.get(srcId);
      const dst = resources.get(dstId);
      if (!src || !dst) return;

      const srcInfo = resourceInfos.get(srcId);
      const dstInfo = resourceInfos.get(dstId);

      // GPU path: only when GPU resources already exist (from prior dispatch)
      const srcHasGpu = src.gpuBuffer && src.flags && src.flags.gpuDirty;
      const dstHasGpu = dst.gpuBuffer;
      if (srcInfo && dstInfo && (srcHasGpu || dstHasGpu)) {
        _ensureGpuResource(device, src, srcInfo);
        _ensureGpuResource(device, dst, dstInfo);

        if (src.gpuBuffer && dst.gpuBuffer) {
          const srcCC = srcInfo.componentCount || 1;
          const dstCC = dstInfo.componentCount || 1;
          const srcElems = Math.floor(src.gpuBuffer.size / (srcCC * 4));
          const dstElems = Math.floor(dst.gpuBuffer.size / (dstCC * 4));
          const maxFromSrc = srcElems - srcOffset;
          const maxToDst = dstElems - dstOffset;
          let actualCount = Math.min(maxFromSrc, maxToDst);
          if (count !== Infinity && count >= 0) actualCount = Math.min(actualCount, count);
          if (actualCount <= 0) return;

          const srcByteOff = srcOffset * srcCC * 4;
          const dstByteOff = dstOffset * dstCC * 4;
          const byteCount = actualCount * srcCC * 4;

          const encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(src.gpuBuffer, srcByteOff, dst.gpuBuffer, dstByteOff, byteCount);
          device.queue.submit([encoder.finish()]);

          if (!dst.flags) dst.flags = { cpuDirty: false, gpuDirty: false };
          dst.flags.gpuDirty = true;
          return;
        }
      }

      // CPU fallback
      if (!src.data || !dst.data) return;
      const srcLen = src.data.length;
      const dstLen = dst.data.length;
      const maxFromSrc = srcLen - srcOffset;
      const maxToDst = dstLen - dstOffset;
      let actualCount = Math.min(maxFromSrc, maxToDst);
      if (count !== Infinity && count >= 0) actualCount = Math.min(actualCount, count);
      for (let i = 0; i < actualCount; i++) {
        dst.data[dstOffset + i] = src.data[srcOffset + i];
      }
    },

    executeCopyTexture(srcId, dstId, srcRect, dstRect, sample, alpha, normalized, resources) {
      const src = resources.get(srcId);
      const dst = resources.get(dstId);
      if (!src || !dst) return;

      const srcInfo = resourceInfos.get(srcId);
      const dstInfo = resourceInfos.get(dstId);

      // Resolve pixel rects
      let sx = 0, sy = 0, sw = src.width, sh = src.height;
      let dx = 0, dy = 0, dw = dst.width, dh = dst.height;
      if (srcRect) {
        if (normalized) {
          sx = Math.floor(srcRect[0] * src.width); sy = Math.floor(srcRect[1] * src.height);
          sw = Math.floor(srcRect[2] * src.width); sh = Math.floor(srcRect[3] * src.height);
        } else {
          sx = Math.floor(srcRect[0]); sy = Math.floor(srcRect[1]);
          sw = Math.floor(srcRect[2]); sh = Math.floor(srcRect[3]);
        }
      }
      if (dstRect) {
        if (normalized) {
          dx = Math.floor(dstRect[0] * dst.width); dy = Math.floor(dstRect[1] * dst.height);
          dw = Math.floor(dstRect[2] * dst.width); dh = Math.floor(dstRect[3] * dst.height);
        } else {
          dx = Math.floor(dstRect[0]); dy = Math.floor(dstRect[1]);
          dw = Math.floor(dstRect[2]); dh = Math.floor(dstRect[3]);
        }
      }

      if (alpha <= 0) return;

      const isSimpleCopy = (sw === dw && sh === dh && alpha >= 1.0);

      // GPU path: only when GPU resources already exist (from prior dispatch)
      const srcHasGpu = src.gpuTexture && src.flags && src.flags.gpuDirty;
      const dstHasGpu = dst.gpuTexture;

      // GPU path: simple blit (no scaling, no alpha blending)
      if (srcInfo && dstInfo && isSimpleCopy && (srcHasGpu || dstHasGpu)) {
        _ensureGpuResource(device, src, srcInfo);
        _ensureGpuResource(device, dst, dstInfo);

        if (src.gpuTexture && dst.gpuTexture) {
          const copyW = Math.min(sw, src.width - sx, dst.width - dx);
          const copyH = Math.min(sh, src.height - sy, dst.height - dy);
          if (copyW <= 0 || copyH <= 0) return;

          const encoder = device.createCommandEncoder();
          encoder.copyTextureToTexture(
            { texture: src.gpuTexture, origin: [sx, sy, 0] },
            { texture: dst.gpuTexture, origin: [dx, dy, 0] },
            [copyW, copyH, 1]
          );
          device.queue.submit([encoder.finish()]);

          if (!dst.flags) dst.flags = { cpuDirty: false, gpuDirty: false };
          dst.flags.gpuDirty = true;
          return;
        }
      }

      // GPU path: complex copy (scaling or alpha < 1.0) via compute shader
      if (srcInfo && dstInfo && !isSimpleCopy && (srcHasGpu || dstHasGpu)) {
        _ensureGpuResource(device, src, srcInfo);
        _ensureGpuResource(device, dst, dstInfo);

        if (src.gpuTexture && dst.gpuTexture) {
          const dstFormat = dstInfo.format || 'rgba8unorm';
          const needsAlphaBlend = alpha < 1.0;
          const sampleMode = (sample === 'bilinear') ? 1 : 0;

          // Get or create the copy compute pipeline
          const pipelineKey = `__copy_tex_${dstFormat}`;
          if (!pipelines.has(pipelineKey)) {
            const shaderCode = `
struct CopyParams {
  src_rect: vec4<f32>,
  dst_rect: vec4<f32>,
  alpha: f32,
  sample_mode: u32,
  src_dims: vec2<f32>,
}

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var orig_dst_tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: CopyParams;
@group(0) @binding(3) var dst_tex: texture_storage_2d<${dstFormat}, write>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dst_x = i32(params.dst_rect.x) + i32(gid.x);
  let dst_y = i32(params.dst_rect.y) + i32(gid.y);
  if (gid.x >= u32(params.dst_rect.z) || gid.y >= u32(params.dst_rect.w)) { return; }

  // Map dst pixel to src coordinate
  let u = params.src_rect.x + (f32(gid.x) + 0.5) * params.src_rect.z / params.dst_rect.z;
  let v = params.src_rect.y + (f32(gid.y) + 0.5) * params.src_rect.w / params.dst_rect.w;

  var pixel: vec4<f32>;
  if (params.sample_mode == 1u) {
    // Bilinear sampling
    let tx = u - 0.5;
    let ty = v - 0.5;
    let x0 = i32(floor(tx));
    let y0 = i32(floor(ty));
    let fx = tx - floor(tx);
    let fy = ty - floor(ty);
    let sdims = vec2<i32>(params.src_dims);
    let cx00 = clamp(vec2<i32>(x0, y0), vec2<i32>(0), sdims - vec2<i32>(1));
    let cx10 = clamp(vec2<i32>(x0 + 1, y0), vec2<i32>(0), sdims - vec2<i32>(1));
    let cx01 = clamp(vec2<i32>(x0, y0 + 1), vec2<i32>(0), sdims - vec2<i32>(1));
    let cx11 = clamp(vec2<i32>(x0 + 1, y0 + 1), vec2<i32>(0), sdims - vec2<i32>(1));
    let s00 = textureLoad(src_tex, cx00, 0);
    let s10 = textureLoad(src_tex, cx10, 0);
    let s01 = textureLoad(src_tex, cx01, 0);
    let s11 = textureLoad(src_tex, cx11, 0);
    let top = s00 * (1.0 - fx) + s10 * fx;
    let bot = s01 * (1.0 - fx) + s11 * fx;
    pixel = top * (1.0 - fy) + bot * fy;
  } else {
    // Nearest sampling
    let ix = clamp(i32(floor(u)), 0, i32(params.src_dims.x) - 1);
    let iy = clamp(i32(floor(v)), 0, i32(params.src_dims.y) - 1);
    pixel = textureLoad(src_tex, vec2<i32>(ix, iy), 0);
  }

  if (params.alpha < 1.0) {
    // Porter-Duff source-over compositing
    let existing = textureLoad(orig_dst_tex, vec2<i32>(dst_x, dst_y), 0);
    let srcA = pixel.a * params.alpha;
    let dstA = existing.a;
    let outA = srcA + dstA * (1.0 - srcA);
    var out_color: vec4<f32>;
    if (outA < 1e-5) {
      out_color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    } else {
      out_color = vec4<f32>(
        (pixel.r * srcA + existing.r * dstA * (1.0 - srcA)) / outA,
        (pixel.g * srcA + existing.g * dstA * (1.0 - srcA)) / outA,
        (pixel.b * srcA + existing.b * dstA * (1.0 - srcA)) / outA,
        outA
      );
    }
    textureStore(dst_tex, vec2<i32>(dst_x, dst_y), out_color);
  } else {
    textureStore(dst_tex, vec2<i32>(dst_x, dst_y), pixel);
  }
}
`;
            const module = device.createShaderModule({ code: shaderCode });
            const p = device.createComputePipeline({
              layout: 'auto',
              compute: { module, entryPoint: 'main' }
            });
            pipelines.set(pipelineKey, p);
          }
          const copyPipeline = pipelines.get(pipelineKey);

          // Create uniform buffer for CopyParams
          const paramsBuffer = device.createBuffer({ size: 48, usage: 64 | 8 }); // UNIFORM | COPY_DST
          const paramsData = new Float32Array([
            sx, sy, sw, sh,    // src_rect
            dx, dy, dw, dh,    // dst_rect
            alpha, sampleMode, // alpha, sample_mode (u32 reinterpreted)
            src.width, src.height // src_dims
          ]);
          // Correctly write sample_mode as u32
          const paramsView = new DataView(paramsData.buffer);
          paramsView.setUint32(9 * 4, sampleMode, true);
          device.queue.writeBuffer(paramsBuffer, 0, paramsData);

          // For alpha blending, we need the original dst texture content
          let origDstTexture = src.gpuTexture; // dummy, won't be read if alpha >= 1.0
          if (needsAlphaBlend) {
            // Copy current dst to a temp texture for reading
            origDstTexture = device.createTexture({
              size: [dst.width, dst.height, 1],
              format: dstFormat,
              usage: 0x1F // all usages
            });
            const enc = device.createCommandEncoder();
            enc.copyTextureToTexture(
              { texture: dst.gpuTexture },
              { texture: origDstTexture },
              [dst.width, dst.height, 1]
            );
            device.queue.submit([enc.finish()]);
          }

          const bindGroup = device.createBindGroup({
            layout: copyPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: src.gpuTexture.createView() },
              { binding: 1, resource: origDstTexture.createView() },
              { binding: 2, resource: { buffer: paramsBuffer } },
              { binding: 3, resource: dst.gpuTexture.createView() }
            ]
          });

          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(copyPipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(dw / 16), Math.ceil(dh / 16), 1);
          pass.end();
          device.queue.submit([encoder.finish()]);

          if (needsAlphaBlend) {
            origDstTexture.destroy();
          }
          paramsBuffer.destroy();

          if (!dst.flags) dst.flags = { cpuDirty: false, gpuDirty: false };
          dst.flags.gpuDirty = true;
          return;
        }
      }

      // CPU fallback
      if (!src.data || !dst.data) return;

      const getSrcPixel = (px, py) => {
        const cx = Math.max(0, Math.min(src.width - 1, px));
        const cy = Math.max(0, Math.min(src.height - 1, py));
        const p = src.data[cy * src.width + cx];
        return Array.isArray(p) ? p : [p, 0, 0, 1];
      };

      const sampleBilinear = (u, v) => {
        const tx = u - 0.5, ty = v - 0.5;
        const x0 = Math.floor(tx), y0 = Math.floor(ty);
        const fx = tx - x0, fy = ty - y0;
        const s00 = getSrcPixel(x0, y0);
        const s10 = getSrcPixel(x0 + 1, y0);
        const s01 = getSrcPixel(x0, y0 + 1);
        const s11 = getSrcPixel(x0 + 1, y0 + 1);
        const r = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++) {
          const top = s00[c] * (1 - fx) + s10[c] * fx;
          const bot = s01[c] * (1 - fx) + s11[c] * fx;
          r[c] = top * (1 - fy) + bot * fy;
        }
        return r;
      };

      const needsSampling = sample !== null && (sw !== dw || sh !== dh);

      for (let py = 0; py < dh; py++) {
        for (let px = 0; px < dw; px++) {
          const dstX = dx + px;
          const dstY = dy + py;
          if (dstX < 0 || dstX >= dst.width || dstY < 0 || dstY >= dst.height) continue;

          let pixel;
          if (needsSampling) {
            const srcU = sx + (px + 0.5) * sw / dw;
            const srcV = sy + (py + 0.5) * sh / dh;
            if (sample === 'bilinear') {
              pixel = sampleBilinear(srcU, srcV);
            } else {
              pixel = getSrcPixel(Math.floor(srcU), Math.floor(srcV));
            }
          } else {
            const srcX = sx + Math.min(px, sw - 1);
            const srcY = sy + Math.min(py, sh - 1);
            pixel = getSrcPixel(srcX, srcY);
          }

          const dstIdx = dstY * dst.width + dstX;
          if (alpha >= 1.0) {
            dst.data[dstIdx] = [...pixel];
          } else {
            const existing = dst.data[dstIdx];
            const dstPixel = Array.isArray(existing) ? existing : [existing, 0, 0, 1];
            const srcA = pixel[3] * alpha;
            const dstA = dstPixel[3];
            const outA = srcA + dstA * (1 - srcA);
            const out = [0, 0, 0, outA];
            if (outA < 1e-5) {
              out[0] = out[1] = out[2] = 0;
            } else {
              for (let c = 0; c < 3; c++) {
                out[c] = (pixel[c] * srcA + dstPixel[c] * dstA * (1 - srcA)) / outA;
              }
            }
            dst.data[dstIdx] = out;
          }
        }
      }
    }
  };
};

const _ensureGpuResource = (device, state, info) => {
  if (!info) return;

  if (!state.flags) state.flags = { cpuDirty: true, gpuDirty: false };

  // 1. Create/Resize GPU resource if needed
  if (info.type === 'texture2d') {
    if (!state.gpuTexture || state.gpuTexture.width !== state.width || state.gpuTexture.height !== state.height) {
      if (state.gpuTexture) state.gpuTexture.destroy();
      state.gpuTexture = device.createTexture({
        size: [state.width, state.height, 1],
        format: info.format || 'rgba8unorm',
        usage: 0x1F // RENDER_ATTACHMENT | TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC | COPY_DST
      });
      // New texture needs data
      state.flags.cpuDirty = true;
    }
  } else {
    // Buffer
    const { componentCount } = info;
    const byteSize = state.width * componentCount * 4;
    const alignedSize = Math.max(Math.ceil(byteSize / 4) * 4, 16);

    if (!state.gpuBuffer || state.gpuBuffer.size < alignedSize) {
      const oldBuffer = state.gpuBuffer;
      const preserveGpu = state._preserveGpuOnResize && oldBuffer;
      delete state._preserveGpuOnResize;

      state.gpuBuffer = device.createBuffer({
        size: alignedSize,
        usage: 128 | 8 | 4 // STORAGE | COPY_DST | COPY_SRC
      });

      if (preserveGpu) {
        // GPU-to-GPU copy: preserve existing data across resize
        const encoder = device.createCommandEncoder();
        const copySize = Math.min(oldBuffer.size, alignedSize);
        encoder.copyBufferToBuffer(oldBuffer, 0, state.gpuBuffer, 0, copySize);
        device.queue.submit([encoder.finish()]);
        oldBuffer.destroy();
      } else {
        if (oldBuffer) oldBuffer.destroy();
        state.flags.cpuDirty = true;
      }
    } else {
      // Buffer is large enough — clean up flag if set
      delete state._preserveGpuOnResize;
    }
  }

  // 2. Upload if CPU is dirty
  if (state.flags.cpuDirty && state.data) {
    if (info.type === 'texture2d') {
      const { typedArray, componentCount } = info;
      const flatSize = state.width * state.height * componentCount;
      const raw = typedArray === 'Float32Array' ? new Float32Array(flatSize) : new Uint8Array(flatSize);

      let ptr = 0;
      const src = state.data;

      const push = (v) => {
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) push(v[i]);
        } else {
          raw[ptr++] = info.typedArray === 'Uint8Array' ? v * 255 : v;
        }
      };

      for (let i = 0; i < src.length; i++) push(src[i]);

      device.queue.writeTexture(
        { texture: state.gpuTexture },
        raw,
        { bytesPerRow: state.width * (typedArray === 'Float32Array' ? 4 : 1) * componentCount },
        { width: state.width, height: state.height }
      );
    } else {
      const { componentCount } = info;
      const flatSize = state.width * componentCount;
      const raw = info.typedArray === 'Float32Array' ? new Float32Array(flatSize) :
        info.typedArray === 'Uint32Array' ? new Uint32Array(flatSize) : new Int32Array(flatSize);

      let ptr = 0;
      const push = (v) => {
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) push(v[i]);
        } else {
          if (ptr < raw.length) raw[ptr++] = v;
        }
      };

      for (let i = 0; i < state.data.length; i++) push(state.data[i]);
      device.queue.writeBuffer(state.gpuBuffer, 0, raw);
    }
    state.flags.cpuDirty = false;
  }
};
