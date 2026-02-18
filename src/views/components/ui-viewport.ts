import { html, css, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { RuntimeProxy } from '../../runtime/runtime-proxy';
import { appState } from '../../domain/state';
import { appController } from '../../state/controller';
import './ui-icon';

@customElement('ui-viewport')
export class UiViewport extends MobxLitElement {
  @property({ type: Object }) runtime: RuntimeProxy | null = null;

  @query('canvas') private canvas!: HTMLCanvasElement;

  @state() private isDragging = false;
  @state() private statsBottom = 8;

  private canvasAttached = false;
  private resizeObserver: ResizeObserver | null = null;

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
      this.attachCanvasToRuntime();
    }
  }

  firstUpdated() {
    this.attachCanvasToRuntime();
    // Use ResizeObserver to track canvas size changes and notify worker
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === this.canvas && this.runtime) {
          const rect = entry.contentRect;
          const dpr = window.devicePixelRatio || 1;
          this.runtime.resizeCanvas(rect.width, rect.height, dpr);
        }
      }
    });
    if (this.canvas) {
      this.resizeObserver.observe(this.canvas);
    }
  }

  private attachCanvasToRuntime() {
    if (this.canvasAttached || !this.runtime || !this.canvas) return;
    this.runtime.attachCanvas(this.canvas);
    this.canvasAttached = true;
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
    const compileAge = this.formatCompileAge();
    const indicator = this.getCompileIndicator();
    const hasRuntime = !!this.runtime;
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
        <span class="stats-text">${this.runtime?.fps.toFixed(1) || 0} FPS${compileAge ? ` \u00b7 ${compileAge}` : ''}${indicator ? ` \u00b7 ${indicator}` : ''}</span>
        ${hasRuntime ? html`
          <div class="stats-actions">
            <button @click=${() => this.handleDownload()} title="Download screenshot"><ui-icon icon="la-download"></ui-icon></button>
            <button @click=${() => this.handleAttachToChat()} title="Attach to chat"><ui-icon icon="la-comment-alt"></ui-icon></button>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private async captureScreenshotBlob(): Promise<Blob | null> {
    if (!this.runtime) return null;
    const result = await this.runtime.captureScreenshot();
    if (!result) return null;

    // Convert raw RGBA pixels to PNG via OffscreenCanvas
    const { pixels, width, height } = result;
    const imageData = new ImageData(new Uint8ClampedArray(pixels), width, height);
    const tempCanvas = new OffscreenCanvas(width, height);
    const ctx = tempCanvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(imageData, 0, 0);
    return await tempCanvas.convertToBlob({ type: 'image/png' });
  }

  private async handleDownload() {
    const blob = await this.captureScreenshotBlob();
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
    const blob = await this.captureScreenshotBlob();
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      if (!base64) return;
      appController.addDraftImage({ mimeType: 'image/png', data: base64 });
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
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }
}
