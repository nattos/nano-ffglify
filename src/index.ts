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

  // Live drag state (not persisted until pointerup)
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

      ui-left-panel {
        overflow: hidden;
      }

      .viewport-wrapper {
        min-width: 0;
        min-height: 0;
        padding: 24px;
        display: flex;
        overflow: hidden;
        background: #111;
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
      :host(.dragging) .resize-handle.active {
        background: var(--color-emerald-500);
        opacity: 0.4;
      }

      :host(.dragging) .resize-handle.active {
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
    await appState.initialized;
    await this.runDemoScript();
    await appController.restoreTransportState();

    if (!llmManager.hasApiKey) {
      this.showApiKeyDialog = true;
    }

    window.addEventListener('dragover', this.handleGlobalDragOver);
    window.addEventListener('dragleave', this.handleGlobalDragLeave);
    window.addEventListener('drop', this.handleGlobalDrop);
  }

  // --- Drag resize ---
  // Uses window-level listeners so pointer release outside the window is handled correctly
  // and Lit re-renders during drag don't break capture.

  private handleResizeStart(e: PointerEvent, target: 'left' | 'chat') {
    e.preventDefault();
    this.dragTarget = target;
    this.dragStartX = e.clientX;

    if (target === 'left') {
      this.dragStartSize = this.leftCollapsed ? 0 : (appState.local.settings.leftPanelWidth ?? LEFT_PANEL_DEFAULT);
    } else {
      this.dragStartSize = appState.local.settings.chatPanelWidth ?? CHAT_PANEL_DEFAULT;
    }

    // Mark the handle visually
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add('active');
    this.classList.add('dragging');

    window.addEventListener('pointermove', this.onWindowPointerMove);
    window.addEventListener('pointerup', this.onWindowPointerUp);
  }

  private onWindowPointerMove = (e: PointerEvent) => {
    if (!this.dragTarget) return;
    const delta = e.clientX - this.dragStartX;

    if (this.dragTarget === 'left') {
      this.dragLeftWidth = Math.max(0, this.dragStartSize + delta);
    } else {
      this.dragChatWidth = Math.max(CHAT_PANEL_MIN, this.dragStartSize - delta);
    }
  };

  private onWindowPointerUp = (_e: PointerEvent) => {
    window.removeEventListener('pointermove', this.onWindowPointerMove);
    window.removeEventListener('pointerup', this.onWindowPointerUp);

    // Remove visual class from active handle
    this.classList.remove('dragging');
    const activeHandle = this.shadowRoot?.querySelector('.resize-handle.active');
    if (activeHandle) activeHandle.classList.remove('active');

    if (!this.dragTarget) return;

    if (this.dragTarget === 'left') {
      const w = this.dragLeftWidth ?? 0;
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
      if (file.name.endsWith('.json') || file.type === 'application/json') {
        this.handleImportShaderJson(file);
      } else {
        const ids = appController.runtime.getTextureInputIds();
        if (ids.length > 0) {
          appController.runtime.setTextureSource(ids[0], { type: 'file', value: file });
          appController.saveInputFile(ids[0], file);
        }
      }
    }
  };

  private async handleImportShaderJson(file: File) {
    try {
      const text = await file.text();
      const ir = JSON.parse(text);
      if (!ir.version || !ir.functions) {
        console.error('Invalid shader JSON: missing required fields');
        return;
      }
      const baseName = file.name.replace(/\.json$/i, '');
      await appController.importWorkspaceFromIR(ir, baseName);
    } catch (e) {
      console.error('Failed to import shader JSON:', e);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('dragover', this.handleGlobalDragOver);
    window.removeEventListener('dragleave', this.handleGlobalDragLeave);
    window.removeEventListener('drop', this.handleGlobalDrop);
    window.removeEventListener('pointermove', this.onWindowPointerMove);
    window.removeEventListener('pointerup', this.onWindowPointerUp);
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

  private handleDownloadShaderJson() {
    const ir = appState.database.ir;
    const json = JSON.stringify(ir, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const fileName = (ir.meta.name || 'shader').replace(/\s+/g, '_') + '.json';
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  render() {
    const collapsed = this.leftCollapsed && this.dragTarget !== 'left';
    const isDraggingLeft = this.dragTarget === 'left';

    // Compute effective widths
    let effectiveLeftWidth: number;
    if (isDraggingLeft) {
      effectiveLeftWidth = Math.max(0, this.dragLeftWidth ?? 0);
    } else if (collapsed) {
      effectiveLeftWidth = 0;
    } else {
      effectiveLeftWidth = this.dragLeftWidth ?? (appState.local.settings.leftPanelWidth ?? LEFT_PANEL_DEFAULT);
    }

    const effectiveChatWidth = this.dragChatWidth ?? (appState.local.settings.chatPanelWidth ?? CHAT_PANEL_DEFAULT);

    // When collapsed (and not dragging), hide handle too (0px)
    const leftHandleWidth = collapsed ? 0 : 5;

    const gridCols = `48px ${effectiveLeftWidth}px ${leftHandleWidth}px 1fr 5px ${effectiveChatWidth}px`;

    return html`
      ${this.showApiKeyDialog ? html`
        <ui-api-key-dialog @close=${() => this.showApiKeyDialog = false}></ui-api-key-dialog>
      ` : nothing}

      <ui-title-bar @download-zip=${() => this.handleDownloadZip()} @download-shader-json=${() => this.handleDownloadShaderJson()}></ui-title-bar>

      <div class="main-area" style="grid-template-columns: ${gridCols}">
        <ui-nav-bar></ui-nav-bar>
        <ui-left-panel></ui-left-panel>
        <div
          class="resize-handle"
          @pointerdown=${(e: PointerEvent) => this.handleResizeStart(e, 'left')}
        ></div>
        <div class="viewport-wrapper">
          <ui-viewport .runtime=${appController.runtime}></ui-viewport>
        </div>
        <div
          class="resize-handle"
          @pointerdown=${(e: PointerEvent) => this.handleResizeStart(e, 'chat')}
        ></div>
        <ui-chat-panel></ui-chat-panel>
      </div>

      <div class="global-drop-zone ${this.isGlobalDragging ? 'active' : ''}">
        Drop to Import
      </div>
    `;
  }
}
