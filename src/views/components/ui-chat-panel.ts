import './ui-button';
import './ui-icon';
import { MobxLitElement } from '../mobx-lit-element';
import { css, html } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appState } from '../../domain/state';
import { appController } from '../../state/controller';
import { chatHandler } from '../../llm/chat-handler';

@customElement('ui-chat-panel')
export class UiChatPanel extends MobxLitElement {
  @query('.chat-history') private chatHistory!: HTMLElement;
  @query('.chat-input') private chatInput!: HTMLTextAreaElement;

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
      }
      .msg.assistant {
        align-self: flex-start;
      }
      .msg.tool-response {
        align-self: flex-start;
        font-size: 0.75rem;
        opacity: 0.7;
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
        align-items: flex-end;
        padding: 0.5rem;
        gap: 0.5rem;
        flex-shrink: 0;
      }

      .chat-input {
        flex: 1;
        padding: 0.5rem;
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
      }

      .chat-input:focus {
        outline: none;
        border-color: var(--color-emerald-500);
      }
    `
  ];

  private async handleSend() {
    const text = appState.local.draftChat;
    if (!text.trim()) return;
    appController.setDraftChat('');
    this.autoResizeTextarea();
    await chatHandler.handleUserMessage(text);
  }

  private handleInput(e: any) {
    appController.setDraftChat(e.target.value);
    this.autoResizeTextarea();
  }

  private autoResizeTextarea() {
    const ta = this.chatInput;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
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
    const { draftChat, llmBusy } = appState.local;

    return html`
      <div class="header">
        <span class="header-title">Chat</span>
      </div>

      <div class="chat-history" @scroll=${() => this.handleScroll()}>
        ${chat_history.map(msg => html`
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
        <textarea
          class="chat-input"
          rows="1"
          .value=${draftChat}
          ?disabled=${llmBusy}
          @input=${(e: any) => this.handleInput(e)}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSend(); } }}
          placeholder=${llmBusy ? 'Waiting for response...' : 'Type a message...'}
        ></textarea>
        <ui-button icon="la-paper-plane" square ?disabled=${llmBusy} @click=${() => this.handleSend()} title="Send"></ui-button>
      </div>
    `;
  }
}
