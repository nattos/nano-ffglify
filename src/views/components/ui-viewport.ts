import { html, css, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { RuntimeManager } from '../../runtime/runtime-manager';
import { appState } from '../../domain/state';
import { appController } from '../../state/controller';
import './ui-icon';

@customElement('ui-viewport')
export class UiViewport extends MobxLitElement {
  @property({ type: Object }) runtime: RuntimeManager | null = null;

  @query('canvas') private canvas!: HTMLCanvasElement;

  @state() private isDragging = false;
  @state() private statsBottom = 8;

  private context: GPUCanvasContext | null = null;
  private unsubscribe: (() => void) | null = null;

  private blitPipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  private lastScaleX = 1;
  private lastScaleY = 1;

  static readonly styles = css`
    :host {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
      image-rendering: pixelated;
    }
    .overlay {
      position: absolute;
      inset: 0;
      background: rgba(16, 185, 129, 0.2);
      border: 2px dashed var(--color-emerald-500);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: bold;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .overlay.active {
      opacity: 1;
    }
    .stats-bar {
      position: absolute;
      left: 0;
      right: 0;
      padding: 0 0;
      display: flex;
      align-items: center;
      font-family: monospace;
      font-size: 10px;
      color: rgba(255, 255, 255, 0.25);
      z-index: 10;
      white-space: nowrap;
      line-height: 18px;
    }
    .stats-text {
      pointer-events: none;
    }
    .stats-actions {
      margin-left: auto;
      display: flex;
      gap: 2px;
      transition: opacity 0.15s;
    }
    .stats-actions button {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 3px;
      color: rgba(255, 255, 255, 0.25);
      --icon-size: 11px;
    }
    .stats-actions button:hover {
      color: rgba(255, 255, 255, 0.5);
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

    // Compute stats position: just below the rendered content area
    this.updateStatsPosition(rect);

    this.requestUpdate();
  }

  private updateStatsPosition(hostRect: DOMRect) {
    // The rendered content is centered and scaled by lastScaleX/Y.
    // scaleY gives the fraction of the host height used by the content.
    const contentBottomFromCenter = this.lastScaleY; // in NDC (0..1 range from center)
    // Convert to pixels from top of host
    const contentBottomPx = hostRect.height * (1 + contentBottomFromCenter) / 2;
    // Position stats 8px below content bottom
    const desiredTop = contentBottomPx + 4;
    // But clamp so it doesn't exceed the host (leave 20px for the label itself)
    const maxTop = hostRect.height - 16;
    const clampedTop = Math.min(desiredTop, maxTop);
    // Convert to "bottom" offset for CSS
    this.statsBottom = hostRect.height - clampedTop - 14;
    if (this.statsBottom < 4) this.statsBottom = 4;
  }

  private initBlitPipeline(device: GPUDevice) {
    const shaderCode = `
      struct Params {
        scale: vec2<f32>,
        offset: vec2<f32>,
        screenSize: vec2<f32>,
        texSize: vec2<f32>,
      }
      @group(0) @binding(1) var<uniform> params: Params;

      @vertex
      fn vert_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
        var pos = array<vec2<f32>, 4>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>(1.0, -1.0),
          vec2<f32>(-1.0, 1.0),
          vec2<f32>(1.0, 1.0)
        );
        return vec4<f32>(pos[vertexIndex] * params.scale + params.offset, 0.0, 1.0);
      }

      @group(0) @binding(0) var t_src: texture_2d<f32>;

      @fragment
      fn frag_main(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
        let gridSize = 16.0;
        let grid = floor(fragPos.xy / gridSize);
        let checker = (i32(grid.x) + i32(grid.y)) % 2;
        let bgColor = select(vec4<f32>(0.15, 0.15, 0.15, 1.0), vec4<f32>(0.2, 0.2, 0.2, 1.0), checker == 0);

        // Map fragment position directly to integer texel coordinate
        let quadOrigin = (params.screenSize - params.screenSize * params.scale) * 0.5;
        let quadSize = params.screenSize * params.scale;
        let posInQuad = fragPos.xy - quadOrigin;
        let texCoord = vec2<i32>(floor(posInQuad * params.texSize / quadSize));
        let clamped = clamp(texCoord, vec2<i32>(0), vec2<i32>(params.texSize) - 1);
        let srcColor = textureLoad(t_src, clamped, 0);

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

    this.uniformBuffer = device.createBuffer({
      size: 32, // scale(8) + offset(8) + screen(8) + tex(8)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  private renderBlit(device: GPUDevice, srcTexture: GPUTexture) {
    if (!this.context || !this.blitPipeline || !this.uniformBuffer) return;

    const sw = this.canvas.width;
    const sh = this.canvas.height;
    const tw = srcTexture.width;
    const th = srcTexture.height;

    const sRatio = sw / sh;
    const tRatio = tw / th;

    let scaleX = 1.0;
    let scaleY = 1.0;

    if (tRatio > sRatio) {
      scaleY = sRatio / tRatio;
    } else {
      scaleX = tRatio / sRatio;
    }

    this.lastScaleX = scaleX;
    this.lastScaleY = scaleY;

    const params = new Float32Array([
      scaleX, scaleY,
      0, 0,
      sw, sh,
      tw, th
    ]);
    device.queue.writeBuffer(this.uniformBuffer, 0, params);

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }]
    });

    const bindGroup = device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTexture.createView() },
        { binding: 1, resource: { buffer: this.uniformBuffer } }
      ]
    });

    passEncoder.setPipeline(this.blitPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(4);
    passEncoder.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  private formatCompileAge(): string {
    const t = appState.local.lastCompileTime;
    if (!t) return '';
    const ago = Math.floor((Date.now() - t) / 1000);
    if (ago < 30) return 'just now';
    if (ago < 90) return '1 min ago';
    const mins = Math.floor(ago / 60);
    if (mins < 60) return `${mins} min ago`;
    return 'more than an hour ago';
  }

  private getCompileIndicator(): string {
    const status = appState.local.compileStatus;
    const errorCount = appState.local.validationErrors.filter(e => e.severity === 'error').length;
    if (errorCount > 0) return `${errorCount} error${errorCount !== 1 ? 's' : ''}`;
    if (status === 'compiling') return 'compiling\u2026';
    return '';
  }

  render() {
    const textureOutputId = this.runtime?.getPrimaryOutputId() ?? 't_output';
    const outRes = this.runtime?.getResource(textureOutputId);
    const compileAge = this.formatCompileAge();
    const indicator = this.getCompileIndicator();
    return html`
      <canvas
        @dragover=${this.handleDragOver}
        @dragleave=${this.handleDragLeave}
        @drop=${this.handleDrop}
      ></canvas>
      <div class="overlay ${this.isDragging ? 'active' : ''}">
        Drop to Load Texture
      </div>
      <div class="stats-bar" style="bottom: ${this.statsBottom}px">
        <span class="stats-text">${outRes?.width || 0}x${outRes?.height || 0} ${this.runtime?.fps.toFixed(1) || 0} FPS${compileAge ? ` \u00b7 ${compileAge}` : ''}${indicator ? ` \u00b7 ${indicator}` : ''}</span>
        ${outRes ? html`
          <div class="stats-actions">
            <button @click=${() => this.handleDownload()} title="Download screenshot"><ui-icon icon="la-download"></ui-icon></button>
            <button @click=${() => this.handleAttachToChat()} title="Attach to chat"><ui-icon icon="la-comment-alt"></ui-icon></button>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private captureCanvasBlob(): Promise<Blob | null> {
    return new Promise(resolve => {
      if (!this.canvas) return resolve(null);
      this.canvas.toBlob(blob => resolve(blob), 'image/png');
    });
  }

  private async handleDownload() {
    const blob = await this.captureCanvasBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = appState.database.ir?.meta?.name || 'viewport';
    a.download = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async handleAttachToChat() {
    const blob = await this.captureCanvasBlob();
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      if (!base64) return;
      appController.addDraftImage({ mimeType: 'image/png', data: base64 });
      // Open chat panel if closed
      if (!appState.local.settings.chatOpen) {
        appController.setChatOpen(true);
      }
    };
    reader.readAsDataURL(blob);
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    this.isDragging = true;
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  private handleDragLeave() {
    this.isDragging = false;
  }

  private handleDrop(e: DragEvent) {
    e.preventDefault();
    this.isDragging = false;
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
