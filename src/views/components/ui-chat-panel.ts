import './ui-button';
import './ui-icon';
import { MobxLitElement } from '../mobx-lit-element';
import { css, html, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appState } from '../../domain/state';
import { appController } from '../../state/controller';
import { chatHandler } from '../../llm/chat-handler';
import { ChatImageAttachment } from '../../domain/types';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

@customElement('ui-chat-panel')
export class UiChatPanel extends MobxLitElement {
  @query('.chat-history') private chatHistory!: HTMLElement;
  @query('.chat-input') private chatInput!: HTMLTextAreaElement;
  @query('.file-input') private fileInput!: HTMLInputElement;
  @state() private rewindConfirmId: string | null = null;
  @state() private dragOver = false;
  @state() private menuOpen = false;
  @state() private confirmingClear = false;

  private wasPinned = true;

  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        background: #1a1a1a;
        border-left: 1px solid var(--app-border);
        overflow: hidden;
        position: relative;
      }

      .header {
        display: flex;
        align-items: center;
        padding: 0.75rem 0.5rem;
        flex-shrink: 0;
      }

      .header-title {
        font-size: 0.75rem;
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--app-text-muted);
      }

      .menu-anchor {
        margin-left: auto;
        position: relative;
      }
      .menu-btn {
        all: unset;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 3px;
        color: var(--app-text-muted);
        --icon-size: 14px;
      }
      .menu-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--app-text-main);
      }
      .dropdown {
        position: absolute;
        right: 0;
        top: 100%;
        margin-top: 2px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        min-width: 140px;
        z-index: 20;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        overflow: hidden;
      }
      .dropdown-item {
        all: unset;
        display: flex;
        align-items: center;
        gap: 0.4rem;
        width: 100%;
        padding: 0.4rem 0.6rem;
        font-size: 0.75rem;
        color: #e0e0e0;
        cursor: pointer;
        box-sizing: border-box;
      }
      .dropdown-item:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .dropdown-item.danger {
        color: #f87171;
      }

      .chat-history {
        flex: 1;
        overflow-y: auto;
        padding: 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .msg {
        background: #2a2a2a;
        color: #e0e0e0;
        padding: 0.5rem 0.75rem;
        border-radius: 6px;
        max-width: 90%;
        font-size: 0.85rem;
        line-height: 1.4;
        word-break: break-word;
      }
      .msg.user {
        align-self: flex-end;
        background: #0c4a6e;
        position: relative;
        padding-right: 1.75rem;
      }
      .rewind-btn {
        position: absolute;
        right: 0.3rem;
        bottom: 0.3rem;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.25);
        font-size: 1.1rem;
        line-height: 1;
        user-select: none;
        transition: color 0.15s;
      }
      .rewind-btn:hover {
        color: rgba(255, 255, 255, 0.7);
      }
      .rewind-confirm {
        align-self: flex-end;
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.75rem;
        color: var(--app-text-muted);
        padding: 0.25rem 0.5rem;
      }
      .msg.assistant {
        align-self: flex-start;
      }
      .msg.tool-response {
        align-self: flex-start;
        font-size: 0.75rem;
        opacity: 0.7;
      }

      .msg-images {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 4px;
      }
      .msg-images img {
        max-width: 200px;
        max-height: 150px;
        border-radius: 4px;
        object-fit: cover;
      }

      .thinking {
        align-self: flex-start;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
        color: var(--app-text-muted);
      }

      .thinking-dots {
        display: flex;
        gap: 3px;
      }

      .thinking-dots span {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--app-text-muted);
        animation: dot-pulse 1.4s ease-in-out infinite;
      }

      .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
      .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

      @keyframes dot-pulse {
        0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
        40% { opacity: 1; transform: scale(1); }
      }

      .input-area {
        display: flex;
        flex-direction: column;
        padding: 0.5rem;
        gap: 0.35rem;
        flex-shrink: 0;
      }

      .draft-previews {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .draft-preview {
        position: relative;
        width: 60px;
        height: 60px;
      }
      .draft-preview img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 4px;
        border: 1px solid #444;
      }
      .draft-preview .remove-btn {
        position: absolute;
        top: -4px;
        right: -4px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #e53e3e;
        color: white;
        border: none;
        font-size: 10px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }

      .input-row {
        display: flex;
        align-items: flex-end;
        gap: 0.5rem;
      }

      .chat-input {
        flex: 1;
        padding: 0.4rem 0.5rem;
        background: #2a2a2a;
        color: #e0e0e0;
        border: 1px solid #444;
        border-radius: 4px;
        font-size: 0.85rem;
        font-family: inherit;
        resize: none;
        overflow-y: auto;
        max-height: 150px;
        line-height: 1.4;
        box-sizing: border-box;
        height: calc(0.85rem * 1.4 + 0.8rem + 1px);
      }

      .chat-input:focus {
        outline: none;
        border-color: var(--color-emerald-500);
      }

      .file-input {
        display: none;
      }

      .drop-overlay {
        position: absolute;
        inset: 0;
        background: rgba(16, 185, 129, 0.15);
        border: 2px dashed var(--color-emerald-500);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.9rem;
        color: var(--color-emerald-500);
        pointer-events: none;
        z-index: 10;
      }
    `
  ];

  private handleStop() {
    chatHandler.stop();
  }

  private handleRewindClick(msgId: string) {
    this.rewindConfirmId = msgId;
  }

  private handleRewindConfirm() {
    if (this.rewindConfirmId) {
      appController.rewindToChat(this.rewindConfirmId);
      this.rewindConfirmId = null;
      this.autoResizeTextarea();
    }
  }

  private handleRewindCancel() {
    this.rewindConfirmId = null;
  }

  private toggleMenu() {
    this.menuOpen = !this.menuOpen;
    this.confirmingClear = false;
    if (this.menuOpen) {
      // Close on outside click
      const close = (e: MouseEvent) => {
        const path = e.composedPath();
        if (!path.some(el => (el as HTMLElement)?.classList?.contains('menu-anchor'))) {
          this.menuOpen = false;
          this.confirmingClear = false;
          document.removeEventListener('click', close, true);
        }
      };
      requestAnimationFrame(() => document.addEventListener('click', close, true));
    }
  }

  private handleClearHistory() {
    if (!this.confirmingClear) {
      this.confirmingClear = true;
      return;
    }
    appController.clearChatHistory();
    this.menuOpen = false;
    this.confirmingClear = false;
  }

  private async handleSend() {
    const text = appState.local.draftChat;
    const images = [...appState.local.draftImages];
    if (!text.trim() && !images.length) return;
    appController.setDraftChat('');
    appController.clearDraftImages();
    this.autoResizeTextarea();
    // Re-focus after clearing so the user can keep typing
    requestAnimationFrame(() => this.chatInput?.focus());
    await chatHandler.handleUserMessage(text, images.length ? images : undefined);
  }

  private handleInput(e: any) {
    appController.setDraftChat(e.target.value);
    this.autoResizeTextarea();
  }

  private handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) this.addImageFromFile(file);
      }
    }
  }

  private autoResizeTextarea() {
    const ta = this.chatInput;
    if (!ta) return;
    ta.style.height = '';
    ta.style.height = Math.max(ta.scrollHeight, ta.offsetHeight) + 'px';
  }

  private handleUploadClick() {
    this.fileInput?.click();
  }

  private handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files) return;
    for (const file of Array.from(input.files)) {
      this.addImageFromFile(file);
    }
    input.value = '';
  }

  private addImageFromFile(file: File) {
    if (!file.type.startsWith('image/')) return;
    if (file.size > MAX_IMAGE_SIZE) {
      console.warn(`Skipping ${file.name}: exceeds 10MB limit`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      if (!base64) return;
      const attachment: ChatImageAttachment = {
        mimeType: file.type,
        data: base64,
      };
      appController.addDraftImage(attachment);
    };
    reader.readAsDataURL(file);
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragOver = true;
  }

  private handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragOver = false;
  }

  private handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragOver = false;
    if (!e.dataTransfer?.files) return;
    for (const file of Array.from(e.dataTransfer.files)) {
      this.addImageFromFile(file);
    }
  }

  protected updated() {
    if (this.wasPinned && this.chatHistory) {
      this.chatHistory.scrollTop = this.chatHistory.scrollHeight;
    }
  }

  private handleScroll() {
    if (!this.chatHistory) return;
    const el = this.chatHistory;
    this.wasPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }

  render() {
    const { chat_history } = appState.database;
    const { draftChat, draftImages, llmBusy } = appState.local;

    return html`
      ${this.dragOver ? html`<div class="drop-overlay">Drop images here</div>` : nothing}

      <div class="header">
        <span class="header-title">Chat</span>
        <div class="menu-anchor">
          <button class="menu-btn" @click=${() => this.toggleMenu()} title="Options">
            <ui-icon icon="la-ellipsis-v"></ui-icon>
          </button>
          ${this.menuOpen ? html`
            <div class="dropdown">
              <button class="dropdown-item ${this.confirmingClear ? 'danger' : ''}" @click=${() => this.handleClearHistory()}>
                ${this.confirmingClear ? 'Confirm clear?' : 'Clear history'}
              </button>
            </div>
          ` : nothing}
        </div>
      </div>

      <div class="chat-history"
        @scroll=${() => this.handleScroll()}
        @dragover=${(e: DragEvent) => this.handleDragOver(e)}
        @dragleave=${(e: DragEvent) => this.handleDragLeave(e)}
        @drop=${(e: DragEvent) => this.handleDrop(e)}
      >
        ${chat_history.map(msg => msg.role === 'user' ? html`
          ${this.rewindConfirmId === msg.id ? html`
            <div class="rewind-confirm">
              Rewind to here?
              <ui-button size="small" @click=${() => this.handleRewindConfirm()}>Rewind</ui-button>
              <ui-button size="small" variant="ghost" @click=${() => this.handleRewindCancel()}>Cancel</ui-button>
            </div>
          ` : nothing}
          <div class="msg user">
            ${msg.images?.length ? html`
              <div class="msg-images">
                ${msg.images.map(img => html`
                  <img src="data:${img.mimeType};base64,${img.data}" alt="attached image" />
                `)}
              </div>
            ` : nothing}
            ${msg.text}
            ${!llmBusy ? html`<span class="rewind-btn" @click=${() => this.handleRewindClick(msg.id)} title="Rewind to this message">\u21ba</span>` : nothing}
          </div>
        ` : html`
          <div class="msg ${msg.role}">
            ${msg.role === 'tool-response'
              ? html`${msg.text || msg.data?.message || 'tool response'}`
              : msg.text}
          </div>
        `)}
        ${llmBusy ? html`
          <div class="thinking">
            <div class="thinking-dots"><span></span><span></span><span></span></div>
            ${appState.local.llmStatus || 'Thinking'}
          </div>
        ` : ''}
      </div>

      <div class="input-area">
        ${draftImages.length ? html`
          <div class="draft-previews">
            ${draftImages.map((img, i) => html`
              <div class="draft-preview">
                <img src="data:${img.mimeType};base64,${img.data}" alt="draft" />
                <button class="remove-btn" @click=${() => appController.removeDraftImage(i)} title="Remove">\u00d7</button>
              </div>
            `)}
          </div>
        ` : nothing}
        <div class="input-row">
          <input class="file-input" type="file" accept="image/*" multiple @change=${(e: Event) => this.handleFileSelect(e)} />
          <ui-button icon="la-image" square @click=${() => this.handleUploadClick()} title="Attach image" ?disabled=${llmBusy}></ui-button>
          <textarea
            class="chat-input"
            rows="1"
            .value=${draftChat}
            ?disabled=${llmBusy}
            @input=${(e: any) => this.handleInput(e)}
            @paste=${(e: ClipboardEvent) => this.handlePaste(e)}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSend(); } }}
            placeholder=${llmBusy ? 'Waiting for response...' : 'Type a message...'}
          ></textarea>
          ${llmBusy
            ? html`<ui-button icon="la-stop" square @click=${() => this.handleStop()} title="Stop"></ui-button>`
            : html`<ui-button icon="la-paper-plane" square @click=${() => this.handleSend()} title="Send"></ui-button>`
          }
        </div>
      </div>
    `;
  }
}
