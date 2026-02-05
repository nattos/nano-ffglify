import { LitElement, html, css } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { RuntimeManager } from '../../runtime/runtime-manager';

@customElement('ui-viewport')
export class UiViewport extends LitElement {
  @property({ type: Object }) runtime: RuntimeManager | null = null;

  @query('canvas') private canvas!: HTMLCanvasElement;

  private context: GPUCanvasContext | null = null;
  private unsubscribe: (() => void) | null = null;

  private blitPipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  static readonly styles = css`
        :host {
            display: flex;
            flex-direction: column;
            background: #111;
            border-radius: 8px;
            overflow: hidden;
            position: relative;
            aspect-ratio: 16 / 9;
        }
        canvas {
            width: 100%;
            height: 100%;
            display: block;
            image-rendering: pixelated;
        }
        .stats {
            position: absolute;
            top: 8px;
            left: 8px;
            background: rgba(0, 0, 0, 0.6);
            color: #fff;
            padding: 4px 8px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 10px;
            pointer-events: none;
            z-index: 10;
        }
    `;

  updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('runtime')) {
      this.setupSubscription();
    }
  }

  private setupSubscription() {
    if (this.unsubscribe) this.unsubscribe();
    if (this.runtime) {
      this.unsubscribe = this.runtime.onNewFrame(this.handleNewFrame.bind(this));
    }
  }

  private handleNewFrame(texture: GPUTexture) {
    if (!this.canvas || !texture || !this.runtime?.device) return;

    const device = this.runtime.device;

    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.floor(rect.width * dpr);
    const ch = Math.floor(rect.height * dpr);

    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }

    if (!this.context) {
      this.context = this.canvas.getContext('webgpu');
      if (this.context) {
        this.context.configure({
          device: device,
          format: navigator.gpu.getPreferredCanvasFormat(),
          alphaMode: 'premultiplied',
        });
      }
    }

    if (!this.blitPipeline) {
      this.initBlitPipeline(device);
    }

    if (this.context && this.blitPipeline) {
      this.renderBlit(device, texture);
    }
    this.requestUpdate();
  }

  private initBlitPipeline(device: GPUDevice) {
    const shaderCode = `
            struct Params {
                scale: vec2<f32>,
                offset: vec2<f32>,
                screenSize: vec2<f32>,
                texSize: vec2<f32>,
            }
            @group(0) @binding(2) var<uniform> params: Params;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>,
            }

            @vertex
            fn vert_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                var pos = array<vec2<f32>, 4>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>(1.0, -1.0),
                    vec2<f32>(-1.0, 1.0),
                    vec2<f32>(1.0, 1.0)
                );
                var uv = array<vec2<f32>, 4>(
                    vec2<f32>(0.0, 1.0),
                    vec2<f32>(1.0, 1.0),
                    vec2<f32>(0.0, 0.0),
                    vec2<f32>(1.0, 0.0)
                );

                var out: VertexOutput;
                // Apply Scale and Offset to center the image
                out.position = vec4<f32>(pos[vertexIndex] * params.scale + params.offset, 0.0, 1.0);
                out.uv = uv[vertexIndex];
                return out;
            }

            @group(0) @binding(0) var t_src: texture_2d<f32>;
            @group(0) @binding(1) var s_src: sampler;

            @fragment
            fn frag_main(@location(0) uv: vec2<f32>, @builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
                // Checkerboard background
                let gridSize = 16.0;
                let grid = floor(fragPos.xy / gridSize);
                let checker = (i32(grid.x) + i32(grid.y)) % 2;
                let bgColor = select(vec4<f32>(0.15, 0.15, 0.15, 1.0), vec4<f32>(0.2, 0.2, 0.2, 1.0), checker == 0);

                let srcColor = textureSample(t_src, s_src, uv);

                // Alpha blend over checkerboard
                return mix(bgColor, srcColor, srcColor.a);
            }
        `;

    const module = device.createShaderModule({ code: shaderCode });
    this.blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vert_main' },
      fragment: {
        module,
        entryPoint: 'frag_main',
        targets: [{
          format: navigator.gpu.getPreferredCanvasFormat(),
          blend: {
            color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-strip' }
    });

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.uniformBuffer = device.createBuffer({
      size: 32, // scale(8) + offset(8) + screen(8) + tex(8)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  private renderBlit(device: GPUDevice, srcTexture: GPUTexture) {
    if (!this.context || !this.blitPipeline || !this.sampler || !this.uniformBuffer) return;

    const sw = this.canvas.width;
    const sh = this.canvas.height;
    const tw = srcTexture.width;
    const th = srcTexture.height;

    // Fit logic
    const sRatio = sw / sh;
    const tRatio = tw / th;

    let scaleX = 1.0;
    let scaleY = 1.0;

    if (tRatio > sRatio) {
      // Texture is wider than screen
      scaleY = sRatio / tRatio;
    } else {
      // Texture is taller than screen
      scaleX = tRatio / sRatio;
    }

    const params = new Float32Array([
      scaleX, scaleY, // scale
      0, 0,           // offset
      sw, sh,         // screenSize
      tw, th          // texSize
    ]);
    device.queue.writeBuffer(this.uniformBuffer, 0, params);

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }]
    });

    const bindGroup = device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTexture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } }
      ]
    });

    passEncoder.setPipeline(this.blitPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(4);
    passEncoder.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  render() {
    const outRes = this.runtime?.getResource('t_output');
    return html`
            <canvas
              @dragover=${this.handleDragOver}
              @drop=${this.handleDrop}
            ></canvas>
            <div class="stats">
                FPS: ${this.runtime?.fps.toFixed(1) || 0}<br>
                Frame: ${this.runtime?.frameCount || 0}<br>
                Res: ${outRes?.width || 0}x${outRes?.height || 0}
            </div>
        `;
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  private handleDrop(e: DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file && this.runtime) {
      const textureInputs = this.runtime.getTextureInputIds();
      if (textureInputs.length > 0) {
        const firstSlot = textureInputs[0];
        this.runtime.setTextureSource(firstSlot, { type: 'file', value: file });
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.unsubscribe) this.unsubscribe();
    if (this.uniformBuffer) this.uniformBuffer.destroy();
  }
}
