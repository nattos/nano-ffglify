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
        font-family: monospace;
        white-space: pre-wrap;
      }

      .input-area {
        display: flex;
        padding: 0.5rem;
        gap: 0.5rem;
        background: #181818;
        border-top: 1px solid var(--app-border);
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
    await chatHandler.handleUserMessage(text);
  }

  protected updated() {
    // Autoscroll: if we were pinned to the bottom before render, scroll to bottom now
    if (this.wasPinned && this.chatHistory) {
      this.chatHistory.scrollTop = this.chatHistory.scrollHeight;
    }
  }

  private handleScroll() {
    if (!this.chatHistory) return;
    const el = this.chatHistory;
    // Consider "pinned" if within 30px of the bottom
    this.wasPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }

  render() {
    const { chat_history } = appState.database;
    const { draftChat } = appState.local;

    return html`
      <div class="header">
        <span class="header-title">Chat</span>
      </div>

      <div class="chat-history" @scroll=${() => this.handleScroll()}>
        ${chat_history.map(msg => html`
          <div class="msg ${msg.role}">
            ${msg.role === 'tool-response'
              ? html`<strong>${msg.role}:</strong> ${JSON.stringify(msg.data, undefined, 2)}`
              : html`<strong>${msg.role}:</strong> ${msg.text}`}
          </div>
        `)}
      </div>

      <div class="input-area">
        <input
          class="chat-input"
          .value=${draftChat}
          @input=${(e: any) => appController.setDraftChat(e.target.value)}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.handleSend(); }}
          placeholder="Type a message..."
        />
        <ui-button icon="la-paper-plane" square @click=${() => this.handleSend()} title="Send"></ui-button>
      </div>
    `;
  }
}
