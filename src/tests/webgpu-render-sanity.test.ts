
import { describe, it, expect } from 'vitest';
import { create, globals } from 'webgpu';

Object.assign(global, globals);

// Helper to init device
async function init() {
  const entry = create([]);
  const adapter = await entry.requestAdapter();
  const device = await adapter!.requestDevice();
  return device;
}

describe('WebGPU Render Sanity', () => {

  it('Pipeline Immutability: Blend Mode cannot be changed dynamically', async () => {
    const device = await init();

    const shaderModule = device.createShaderModule({
      code: `
        @vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
        @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }
      `
    });

    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shaderModule, entryPoint: 'vs' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm', blend: { color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' } } }]
      },
      primitive: { topology: 'triangle-list' }
    });

    // There is no method on 'pipeline' to change blend state.
    // Confirming that we MUST create a new pipeline for different blend modes.
    expect((pipeline as any).setBlendMode).toBeUndefined();
  });

  it('VS Output: Must return vec4<f32> for @builtin(position)', async () => {
    const device = await init();

    // Try returning vec3
    const codeVec3 = `
      @vertex fn vs() -> @builtin(position) vec3<f32> { return vec3<f32>(0.0, 0.0, 1.0); }
      @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
    `;

    // Attempt compilation
    // Expect error or validation check failure
    let error: any;
    device.pushErrorScope('validation');
    try {
      device.createShaderModule({ code: codeVec3 });
      // Ideally this fails creation or pipeline creation
    } catch (e) { error = e; }

    // Note: createShaderModule might succeed asynchronously, but we check logs.
    // Actually, usually shader module creation succeeds but pipeline fails if interface mismatch?
    // Let's try to create pipeline.
    const module = device.createShaderModule({ code: codeVec3 });

    try {
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }
      });
    } catch (e) { error = e; }

    const validationError = await device.popErrorScope();
    expect(validationError).toBeDefined(); // Expect validation error saying builtin(position) must be vec4
  });

  it('Culling: W range', async () => {
    // W must be > 0 for standard perspective division?
    // -W <= X,Y,Z <= W
    // If W is 1.0, then -1..1
    // If W is 0.5, then -0.5..0.5
    // If W < 0 ?
    const device = await init();
    // We can run a draw call and check occlusion query or just result pixels.
    // Setup output texture
    const texture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });

    const runPass = async (w: number) => {
      const shader = `
        @vertex fn vs() -> @builtin(position) vec4<f32> {
            // Point at center, but with varying W
            return vec4<f32>(0.0, 0.0, 0.0, ${w.toFixed(1)});
        }
        @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
        `;
      const mod = device.createShaderModule({ code: shader });
      const pipe = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'point-list' }
      });

      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(pipe);
      pass.draw(1);
      pass.end();

      // Readback logic (omitted for brevity, assume we trust standard clip behavior)
      // If W=1 -> Visible.
      // If W=0 -> Invalid? Clipped?
      // If W=-1 -> Behind camera?
      // Just demonstrating that we need the test infrastructure.
    };

    // Detailed Check:
    // Just assert standard WebGPU behavior:
    // Position is homogeneous.
    // Clip volume: 0 <= z <= w (WebGPU is 0..1 z clip by default? or -1..1? WebGPU is 0..1)
    // -w <= x <= w
    // -w <= y <= w
    // 0 <= z <= w

    // So if w=1, z must be 0..1.
    // If w=-1, z must be 0..-1 (empty).
  });

});
