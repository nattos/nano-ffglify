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

  static readonly styles = css`
        :host {
            display: flex;
            flex-direction: column;
            background: #000;
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
                out.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
                out.uv = uv[vertexIndex];
                return out;
            }

            @group(0) @binding(0) var t_src: texture_2d<f32>;
            @group(0) @binding(1) var s_src: sampler;

            @fragment
            fn frag_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
                return textureSample(t_src, s_src, uv);
            }
        `;

    const module = device.createShaderModule({ code: shaderCode });
    this.blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vert_main' },
      fragment: {
        module,
        entryPoint: 'frag_main',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }]
      },
      primitive: { topology: 'triangle-strip' }
    });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  private renderBlit(device: GPUDevice, srcTexture: GPUTexture) {
    if (!this.context || !this.blitPipeline || !this.sampler) return;

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }]
    });

    const bindGroup = device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTexture.createView() },
        { binding: 1, resource: this.sampler }
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
            <canvas></canvas>
            <div class="stats">
                FPS: ${this.runtime?.fps.toFixed(1) || 0}<br>
                Frame: ${this.runtime?.frameCount || 0}<br>
                Res: ${outRes?.width || 0}x${outRes?.height || 0}
            </div>
        `;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.unsubscribe) this.unsubscribe();
  }
}
