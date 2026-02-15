import './ui-button';
import { MobxLitElement } from '../mobx-lit-element';
import { css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appState } from '../../domain/state';
import { appController } from '../../state/controller';
import { llmManager } from '../../llm/llm-manager';
import { DEFAULT_LLM_MODEL } from '../../constants';

@customElement('ui-settings-panel')
export class UiSettingsPanel extends MobxLitElement {
  @state() private apiKeyDraft = '';
  @state() private showKey = false;

  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        padding: 1rem;
        overflow-y: auto;
        gap: 1.5rem;
        color: var(--app-text-main);
      }

      h3 {
        margin: 0;
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--app-text-muted);
      }

      .setting-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
      }

      .setting-label {
        font-size: 0.9rem;
      }

      .setting-description {
        font-size: 0.75rem;
        color: var(--app-text-muted);
        margin-top: 0.25rem;
      }

      .toggle {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        cursor: pointer;
        user-select: none;
      }

      .toggle-track {
        width: 36px;
        height: 20px;
        background: #333;
        border-radius: 10px;
        position: relative;
        transition: background 0.2s ease;
        flex-shrink: 0;
      }

      .toggle.active .toggle-track {
        background: var(--color-emerald-600);
      }

      .toggle-thumb {
        width: 16px;
        height: 16px;
        background: #fff;
        border-radius: 50%;
        position: absolute;
        top: 2px;
        left: 2px;
        transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .toggle.active .toggle-thumb {
        transform: translateX(16px);
      }

      .api-key-row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }

      .api-key-row input {
        flex: 1;
        padding: 0.5rem;
        background: #222;
        color: var(--app-text-main);
        border: 1px solid var(--app-border);
        border-radius: 4px;
        font-family: monospace;
        font-size: 0.85rem;
      }

      .api-key-row input:focus {
        outline: none;
        border-color: var(--color-emerald-500);
      }

      .info {
        font-size: 0.8rem;
        color: var(--app-text-muted);
        font-family: monospace;
      }

      .section {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
    `
  ];

  connectedCallback() {
    super.connectedCallback();
    this.apiKeyDraft = appState.local.settings.apiKey || '';
  }

  private renderToggle(active: boolean, onClick: () => void) {
    return html`
      <div class="toggle ${active ? 'active' : ''}" @click=${onClick}>
        <div class="toggle-track">
          <div class="toggle-thumb"></div>
        </div>
      </div>
    `;
  }

  private handleSaveApiKey() {
    const key = this.apiKeyDraft.trim();
    appController.setApiKey(key || undefined);
    llmManager.reinitialize(key);
  }

  render() {
    const settings = appState.local.settings;

    return html`
      <div class="section">
        <h3>General</h3>
        <div class="setting-row">
          <div>
            <div class="setting-label">Dev Mode</div>
            <div class="setting-description">Show advanced tabs (IR, Raw Code, State, Script, LLM Logs)</div>
          </div>
          ${this.renderToggle(settings.devMode, () => appController.setDevMode(!settings.devMode))}
        </div>
      </div>

      <div class="section">
        <h3>LLM</h3>
        <div class="setting-row">
          <div>
            <div class="setting-label">Use Mock LLM</div>
            <div class="setting-description">Use pre-recorded responses instead of calling the API</div>
          </div>
          ${this.renderToggle(settings.useMockLLM, () => appController.toggleMockLLM(!settings.useMockLLM))}
        </div>

        <div>
          <div class="setting-label">API Key</div>
          <div class="setting-description">Google Generative AI API key</div>
          <div class="api-key-row" style="margin-top: 0.5rem;">
            <input
              .type=${this.showKey ? 'text' : 'password'}
              .value=${this.apiKeyDraft}
              @input=${(e: any) => this.apiKeyDraft = e.target.value}
              placeholder="Enter API key..."
            />
            <ui-button icon=${this.showKey ? 'la-eye-slash' : 'la-eye'} square @click=${() => this.showKey = !this.showKey} title="Toggle visibility"></ui-button>
            <ui-button @click=${() => this.handleSaveApiKey()}>Save</ui-button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-label">Model</div>
          <div class="info">${DEFAULT_LLM_MODEL}</div>
        </div>
      </div>
    `;
  }
}
