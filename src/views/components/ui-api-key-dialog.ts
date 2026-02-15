import './ui-button';
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appController } from '../../state/controller';
import { llmManager } from '../../llm/llm-manager';

@customElement('ui-api-key-dialog')
export class UiApiKeyDialog extends LitElement {
  @state() private keyDraft = '';

  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: block;
      }

      .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 2000;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .dialog {
        background: #1e1e1e;
        border: 1px solid var(--app-border);
        border-radius: 8px;
        padding: 2rem;
        max-width: 440px;
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }

      h2 {
        margin: 0;
        font-size: 1.1rem;
      }

      p {
        margin: 0;
        color: var(--app-text-muted);
        font-size: 0.85rem;
        line-height: 1.5;
      }

      a {
        color: var(--color-emerald-500);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }

      input {
        width: 100%;
        padding: 0.6rem;
        background: #222;
        color: var(--app-text-main);
        border: 1px solid var(--app-border);
        border-radius: 4px;
        font-family: monospace;
        font-size: 0.85rem;
        box-sizing: border-box;
      }

      input:focus {
        outline: none;
        border-color: var(--color-emerald-500);
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
      }
    `
  ];

  private handleSave() {
    const key = this.keyDraft.trim();
    if (key) {
      appController.setApiKey(key);
      llmManager.reinitialize(key);
    }
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private handleSkip() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  render() {
    return html`
      <div class="backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.handleSkip(); }}>
        <div class="dialog">
          <h2>API Key Required</h2>
          <p>Enter your <a href="https://ai.google.dev/gemini-api/docs/api-key" target="_blank">Google Generative AI API key</a> to enable the LLM chat assistant. You can also set this later in Settings.</p>
          <input
            type="password"
            .value=${this.keyDraft}
            @input=${(e: any) => this.keyDraft = e.target.value}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.handleSave(); }}
            placeholder="Enter API key..."
          />
          <div class="actions">
            <ui-button variant="outline" @click=${() => this.handleSkip()}>Skip</ui-button>
            <ui-button variant="primary" @click=${() => this.handleSave()}>Save</ui-button>
          </div>
        </div>
      </div>
    `;
  }
}
