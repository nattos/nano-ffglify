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

@customElement('nano-app')
export class App extends MobxLitElement {
  @state() private isGlobalDragging = false;
  @state() private showApiKeyDialog = false;

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
        grid-template-columns: 48px 300px 1fr 350px;
        overflow: hidden;
      }

      .main-area.left-collapsed {
        grid-template-columns: 48px 0px 1fr 350px;
      }

      ui-viewport {
        min-width: 0;
        min-height: 0;
        aspect-ratio: unset;
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

  async firstUpdated() {
    await this.runDemoScript();

    await appState.initialized;
    await appController.restoreTransportState();

    // Show API key dialog if no key available
    if (!llmManager.hasApiKey) {
      this.showApiKeyDialog = true;
    }

    // Global drag and drop
    window.addEventListener('dragover', this.handleGlobalDragOver);
    window.addEventListener('dragleave', this.handleGlobalDragLeave);
    window.addEventListener('drop', this.handleGlobalDrop);
  }

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
    const collapsed = appState.local.settings.leftPanelCollapsed;

    return html`
      ${this.showApiKeyDialog ? html`
        <ui-api-key-dialog @close=${() => this.showApiKeyDialog = false}></ui-api-key-dialog>
      ` : nothing}

      <ui-title-bar @download-zip=${() => this.handleDownloadZip()}></ui-title-bar>

      <div class="main-area ${collapsed ? 'left-collapsed' : ''}">
        <ui-nav-bar></ui-nav-bar>
        <ui-left-panel></ui-left-panel>
        <ui-viewport .runtime=${appController.runtime}></ui-viewport>
        <ui-chat-panel></ui-chat-panel>
      </div>

      <div class="global-drop-zone ${this.isGlobalDragging ? 'active' : ''}">
        Drop to Load into First Slot
      </div>
    `;
  }
}
