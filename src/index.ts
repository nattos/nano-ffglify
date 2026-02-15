import './views/components/ui-icon';
import './views/components/ui-button';
import './views/components/ui-viewport';
import './views/components/ui-title-bar';
import './views/components/ui-nav-bar';
import './views/components/ui-left-panel';
import './views/components/ui-chat-panel';
import './views/components/ui-api-key-dialog';

import { MobxLitElement } from './views/mobx-lit-element';
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { globalStyles } from './styles';
import { appState } from './domain/state';
import { appController } from './state/controller';
import { chatHandler } from './llm/chat-handler';
import { llmManager } from './llm/llm-manager';
import { AUTO_PLAY_SCRIPT_LINES } from './constants';
import { DEMO_SCRIPT } from './domain/mock-responses';
import { ZipFileSystem } from './metal/virtual-fs';
import { packageFFGLPlugin } from './metal/ffgl-packager';

const LEFT_PANEL_DEFAULT = 300;
const LEFT_PANEL_MIN = 150;
const LEFT_PANEL_COLLAPSE_THRESHOLD = 80;
const CHAT_PANEL_DEFAULT = 350;
const CHAT_PANEL_MIN = 200;

@customElement('nano-app')
export class App extends MobxLitElement {
  @state() private isGlobalDragging = false;
  @state() private showApiKeyDialog = false;

  // Live drag state (not persisted until mouseup)
  @state() private dragLeftWidth: number | null = null;
  @state() private dragChatWidth: number | null = null;
  private dragStartX = 0;
  private dragStartSize = 0;
  private dragTarget: 'left' | 'chat' | null = null;

  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: grid;
        grid-template-rows: auto 1fr;
        height: 100vh;
        width: 100vw;
        background-color: var(--app-bg);
        color: var(--app-text-main);
        font-family: monospace;
        overflow: hidden;
        position: fixed;
        top: 0;
        left: 0;
      }

      .main-area {
        display: grid;
        overflow: hidden;
      }

      .viewport-wrapper {
        min-width: 0;
        min-height: 0;
        padding: 8px;
        display: flex;
        overflow: hidden;
      }

      ui-viewport {
        flex: 1;
        min-width: 0;
        min-height: 0;
        aspect-ratio: unset;
        border-radius: 6px;
      }

      .resize-handle {
        width: 5px;
        cursor: col-resize;
        background: transparent;
        position: relative;
        z-index: 10;
        flex-shrink: 0;
      }

      .resize-handle:hover,
      .resize-handle.active {
        background: var(--color-emerald-500);
        opacity: 0.4;
      }

      .resize-handle.active {
        opacity: 0.6;
      }

      .global-drop-zone {
        position: absolute;
        inset: 0;
        background: rgba(16, 185, 129, 0.1);
        border: 4px dashed var(--color-emerald-500);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-size: 2rem;
        font-weight: bold;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .global-drop-zone.active {
        opacity: 1;
      }
    `
  ];

  private get leftWidth(): number {
    return this.dragLeftWidth ?? appState.local.settings.leftPanelWidth ?? LEFT_PANEL_DEFAULT;
  }

  private get chatWidth(): number {
    return this.dragChatWidth ?? appState.local.settings.chatPanelWidth ?? CHAT_PANEL_DEFAULT;
  }

  private get leftCollapsed(): boolean {
    return !!appState.local.settings.leftPanelCollapsed;
  }

  async firstUpdated() {
    await this.runDemoScript();

    await appState.initialized;
    await appController.restoreTransportState();

    if (!llmManager.hasApiKey) {
      this.showApiKeyDialog = true;
    }

    window.addEventListener('dragover', this.handleGlobalDragOver);
    window.addEventListener('dragleave', this.handleGlobalDragLeave);
    window.addEventListener('drop', this.handleGlobalDrop);
  }

  // --- Drag resize ---

  private handleResizeStart(e: PointerEvent, target: 'left' | 'chat') {
    e.preventDefault();
    this.dragTarget = target;
    this.dragStartX = e.clientX;

    if (target === 'left') {
      this.dragStartSize = this.leftCollapsed ? 0 : this.leftWidth;
    } else {
      this.dragStartSize = this.chatWidth;
    }

    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
  }

  private handleResizeMove = (e: PointerEvent) => {
    if (!this.dragTarget) return;
    const delta = e.clientX - this.dragStartX;

    if (this.dragTarget === 'left') {
      const newWidth = Math.max(0, this.dragStartSize + delta);
      this.dragLeftWidth = newWidth;
    } else {
      // Chat: dragging left makes it wider
      const newWidth = Math.max(CHAT_PANEL_MIN, this.dragStartSize - delta);
      this.dragChatWidth = newWidth;
    }
  };

  private handleResizeEnd = (e: PointerEvent) => {
    if (!this.dragTarget) return;
    const handle = e.currentTarget as HTMLElement;
    handle.classList.remove('active');
    handle.releasePointerCapture(e.pointerId);

    if (this.dragTarget === 'left') {
      const w = this.dragLeftWidth ?? this.leftWidth;
      if (w < LEFT_PANEL_COLLAPSE_THRESHOLD) {
        appController.setLeftPanelCollapsed(true);
      } else {
        appController.setLeftPanelCollapsed(false);
        appController.setLeftPanelWidth(Math.max(LEFT_PANEL_MIN, w));
      }
      this.dragLeftWidth = null;
    } else {
      const w = this.dragChatWidth ?? this.chatWidth;
      appController.setChatPanelWidth(Math.max(CHAT_PANEL_MIN, w));
      this.dragChatWidth = null;
    }

    this.dragTarget = null;
  };

  // --- Global drag and drop ---

  private handleGlobalDragOver = (e: DragEvent) => {
    e.preventDefault();
    this.isGlobalDragging = true;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  private handleGlobalDragLeave = (e: DragEvent) => {
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
      this.isGlobalDragging = false;
    }
  };

  private handleGlobalDrop = (e: DragEvent) => {
    e.preventDefault();
    this.isGlobalDragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) {
      const ids = appController.runtime.getTextureInputIds();
      if (ids.length > 0) {
        appController.runtime.setTextureSource(ids[0], { type: 'file', value: file });
      }
    }
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('dragover', this.handleGlobalDragOver);
    window.removeEventListener('dragleave', this.handleGlobalDragLeave);
    window.removeEventListener('drop', this.handleGlobalDrop);
  }

  private async runDemoScript() {
    if (typeof AUTO_PLAY_SCRIPT_LINES !== 'number') return;

    appController.setChatOpen(true);
    appController.toggleMockLLM(true);

    const limit = AUTO_PLAY_SCRIPT_LINES < 0 ? DEMO_SCRIPT.length : Math.min(AUTO_PLAY_SCRIPT_LINES, DEMO_SCRIPT.length);

    for (let i = 0; i < limit; i++) {
      const text = DEMO_SCRIPT[i];
      appController.setDraftChat(text);
      await new Promise(r => setTimeout(r, 100));
      const draftText = appState.local.draftChat;
      if (draftText.trim()) {
        appController.setDraftChat('');
        await chatHandler.handleUserMessage(draftText);
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  private async handleDownloadZip() {
    try {
      const vfs = new ZipFileSystem();
      await packageFFGLPlugin(vfs, { ir: appState.database.ir });
      const zipData = await vfs.generateZip();
      const blob = new Blob([zipData as any], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fileName = (appState.database.ir.meta.name || 'NanoFFGL').replace(/\s+/g, '_') + '_Build.zip';
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (e) {
      console.error('Failed to package plugin:', e);
    }
  }

  render() {
    const collapsed = this.leftCollapsed;

    // During drag, use live width; otherwise use persisted
    const effectiveLeftWidth = collapsed
      ? (this.dragTarget === 'left' ? Math.max(0, this.dragLeftWidth ?? 0) : 0)
      : (this.dragLeftWidth ?? this.leftWidth);
    const effectiveChatWidth = this.dragChatWidth ?? this.chatWidth;

    const gridCols = `48px ${effectiveLeftWidth}px 5px 1fr 5px ${effectiveChatWidth}px`;

    return html`
      ${this.showApiKeyDialog ? html`
        <ui-api-key-dialog @close=${() => this.showApiKeyDialog = false}></ui-api-key-dialog>
      ` : nothing}

      <ui-title-bar @download-zip=${() => this.handleDownloadZip()}></ui-title-bar>

      <div class="main-area" style="grid-template-columns: ${gridCols}">
        <ui-nav-bar></ui-nav-bar>
        <ui-left-panel style="${collapsed && !this.dragTarget ? 'display:none' : ''}"></ui-left-panel>
        <div
          class="resize-handle"
          @pointerdown=${(e: PointerEvent) => this.handleResizeStart(e, 'left')}
          @pointermove=${this.handleResizeMove}
          @pointerup=${this.handleResizeEnd}
        ></div>
        <div class="viewport-wrapper">
          <ui-viewport .runtime=${appController.runtime}></ui-viewport>
        </div>
        <div
          class="resize-handle"
          @pointerdown=${(e: PointerEvent) => this.handleResizeStart(e, 'chat')}
          @pointermove=${this.handleResizeMove}
          @pointerup=${this.handleResizeEnd}
        ></div>
        <ui-chat-panel></ui-chat-panel>
      </div>

      <div class="global-drop-zone ${this.isGlobalDragging ? 'active' : ''}">
        Drop to Load into First Slot
      </div>
    `;
  }
}
