/**
 * @file index.ts
 * @description Main application entry point.
 * Defines the `<nano-app>` Lit component which composes the UI and connects it to the MobX store.
 *
 * @external-interactions
 * - Imports `globalStyles` (in styles.ts) to set up CSS vars.
 * - Initializes `appState` (singleton).
 *
 * @pitfalls
 * - `render()` is re-called frequently by MobX; keep side-effects out of `render`.
 * - Contains the "Script" debug runner UI logic.
 */
import './views/components/ui-icon';
import './views/components/ui-button';

import { MobxLitElement } from './views/mobx-lit-element';
import { runInAction } from 'mobx';
import { css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { globalStyles } from './styles';
import { appState } from './domain/state';
import { appController } from './state/controller';
import { chatHandler } from './llm/chat-handler';
import { AUTO_PLAY_SCRIPT_LINES } from './constants';
import { DEMO_SCRIPT } from './domain/mock-responses';
import { runScriptDebug } from './debug/script-runner';
import { LLMLogEntry } from './domain/types';

@customElement('nano-app')
export class App extends MobxLitElement {
  @state() scriptLogs: LLMLogEntry[] = [];
  @state() scriptFinalState: any = null;
  @state() runningScriptLine: number | null = null;
  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        width: 100vw;
        background-color: #f5f5f5;
        color: #333;
        font-family: monospace;
        overflow: hidden;
        position: fixed; /* Pin to window */
        top: 0;
        left: 0;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.5rem 1rem;
        background: #fff;
        border-bottom: 1px solid #ccc;
      }

      .title {
        font-weight: bold;
        font-size: 1.1rem;
      }

      .controls {
        display: flex;
        gap: 0.5rem;
      }

      .state-view {
        flex: 1;
        overflow: auto;
        padding: 1rem;
        background: #fff;
        border-bottom: 1px solid #ccc;
      }

      .chat-interface {
        height: 200px;
        display: flex;
        flex-direction: column;
        border-top: 1px solid #ccc;
        background: #eee;
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
        background: white;
        padding: 0.5rem;
        border-radius: 4px;
        max-width: 80%;
      }
      .msg.user { align-self: flex-end; background: #dceefb; }
      .msg.assistant { align-self: flex-start; }

      .input-area {
        display: flex;
        padding: 0.5rem;
        gap: 0.5rem;
        background: #ddd;
      }

      .chat-input {
        flex: 1;
        padding: 0.5rem;
      }

      .tabs {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }

      .tab {
        padding: 0.4rem 0.8rem;
        cursor: pointer;
        opacity: 0.6;
        font-weight: bold;
        transition: opacity 0.2s;
        border-radius: 4px;
      }
      .tab:hover {
        opacity: 0.8;
        background: rgba(0,0,0,0.05);
      }
      .tab.active {
        opacity: 1;
        background: #e0e0e0;
        color: #000;
      }

      .state-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-right: 1px solid #ccc;
        background: #fff;
      }

      .debug-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        padding: 1rem;
        overflow: auto;
      }

      .debug-panel h3 {
        margin-top: 0;
        border-bottom: 2px solid #eee;
        padding-bottom: 0.5rem;
      }

      .debug-panel pre {
        background: #fdfdfd;
        border: 1px solid #eee;
        padding: 1rem;
        border-radius: 4px;
        font-size: 0.85rem;
        flex: 1;
      }

      .compilation-results h4 {
        margin: 1rem 0 0.5rem 0;
      }

      .compilation-results pre {
        flex: none;
      }

      .wgsl-block h5 {
        margin: 0.5rem 0;
        color: #666;
      }
    `
  ];



  async firstUpdated() {
    await this.runDemoScript();
  }

  async runDemoScript() {
    // Note: Manually edit AUTO_PLAY_SCRIPT_LINES to turn debugging on and off.
    if (typeof AUTO_PLAY_SCRIPT_LINES !== 'number') return;

    appController.setChatOpen(true);
    appController.toggleMockLLM(true);

    const limit = AUTO_PLAY_SCRIPT_LINES < 0 ? DEMO_SCRIPT.length : Math.min(AUTO_PLAY_SCRIPT_LINES, DEMO_SCRIPT.length);

    for (let i = 0; i < limit; i++) {
      const text = DEMO_SCRIPT[i];
      const inputEl = this.shadowRoot?.querySelector('.chat-input') as HTMLInputElement;

      if (inputEl) {
        inputEl.value = text;
        inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

        // Wait briefly
        await new Promise(r => setTimeout(r, 100));

        // Simulate Enter or Click Send
        this.handleSend();

        // Wait between messages
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  async runScript(index: number) {
    this.runningScriptLine = index;
    this.scriptLogs = [];
    this.scriptFinalState = null;

    try {
      // Use current setting for the target line
      const useMock = appState.local.settings.useMockLLM;
      const res = await runScriptDebug(index, DEMO_SCRIPT, useMock);

      runInAction(() => {
        this.scriptLogs = res.logs;
        this.scriptFinalState = res.finalState;
      });
    } catch (e) {
      console.error(e);
      alert("Script failed: " + e);
    } finally {
      this.runningScriptLine = null;
    }
  }

  async handleSend() {
    const text = appState.local.draftChat;
    if (!text.trim()) return;
    appController.setDraftChat('');
    await chatHandler.handleUserMessage(text);
  }

  formatLogValue(value: string) {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }

  render() {
    const { database, local } = appState;
    const { chat_history } = database;
    const { draftChat, llmLogs } = local;

    // Serialize the entire appState (database + local)
    // We create a composite object for display
    const displayState = {
      database,
      local: { ...local, llmLogs: `[${llmLogs.length} entries hidden]` } // Hide logs in main state view to reduce noise
    };

    return html`
      <div class="header">
        <div class="title">Nano FFGLify</div>
        <div class="controls">
          <div class="tabs">
            <div class="tab ${local.settings.activeTab === 'state' ? 'active' : ''}" @click=${() => appController.setActiveTab('state')}>State</div>
            <div class="tab ${local.settings.activeTab === 'logs' ? 'active' : ''}" @click=${() => appController.setActiveTab('logs')}>LLM Logs</div>
            <div class="tab ${local.settings.activeTab === 'script' ? 'active' : ''}" @click=${() => appController.setActiveTab('script')}>Script</div>
            <div class="tab ${local.settings.activeTab === 'results' ? 'active' : ''}" @click=${() => appController.setActiveTab('results')}>Results</div>
          </div>
          <div class="divider" style="width: 1px; background: #ccc; margin: 0 0.5rem;"></div>
          <div class="actions" style="display: flex; gap: 0.5rem;">
            <ui-button @click=${() => appController.validateCurrentIR()}>Validate</ui-button>
            <ui-button @click=${() => appController.compileCurrentIR()}>Compile</ui-button>
          </div>
          <div class="divider" style="width: 1px; background: #ccc; margin: 0 0.5rem;"></div>
          <ui-button
            @click=${() => appController.toggleMockLLM(!appState.local.settings.useMockLLM)}
            .variant=${appState.local.settings.useMockLLM ? 'primary' : 'outline'}
          >
            ${appState.local.settings.useMockLLM ? 'Mock' : 'Mock'}
          </ui-button>
          <ui-button icon="la-undo" square @click=${() => appController.undo()} title="Undo"></ui-button>
          <ui-button icon="la-redo" square @click=${() => appController.redo()} title="Redo"></ui-button>
        </div>
      </div>

      <div class="state-view">
        ${local.settings.activeTab === 'state' ? html`
          <div class="debug-panel">
            <h3>App State JSON</h3>
            <pre>${JSON.stringify(displayState, null, 2)}</pre>
          </div>
        ` : ''}

        ${local.settings.activeTab === 'logs' ? html`
          <div class="debug-panel">
            <h3>Latest LLM Logs (Live)</h3>
            <div class="logs-list">
              ${local.llmLogs.map(log => html`
                <div class="log-entry" style="margin-bottom: 2rem; border-bottom: 1px solid #eee; padding-bottom: 1rem;">
                  <div style="font-size:0.8em; color:#888; margin-bottom: 0.5rem;">
                    <strong>ID:</strong> ${log.id} |
                    <strong>Duration:</strong> ${log.duration_ms}ms |
                    <strong>Mocked:</strong> ${log.mocked}
                  </div>

                  <div style="margin-bottom: 0.5rem;"><strong>Prompt:</strong></div>
                  <pre style="white-space: pre-wrap; background: #fffbe5; padding: 0.5rem; max-height: 200px; overflow: auto;">${this.formatLogValue(log.prompt_snapshot)}</pre>

                  <div style="margin-bottom: 0.5rem;"><strong>Response:</strong></div>
                  <pre style="white-space: pre-wrap; background: #e5f9ff; padding: 0.5rem; max-height: 400px; overflow: auto;">${this.formatLogValue(log.response_snapshot)}</pre>
                </div>
              `)}
            </div>
          </div>
        ` : ''}

        ${local.settings.activeTab === 'script' ? html`
          <div class="debug-panel">
            <h3>Demo Script Debugger</h3>
            <p>Run script step-by-step in an isolated environment. Pre-requisite steps are always mocked. Target step uses current "Mock LLM" toggle.</p>

            <div class="script-list">
              ${DEMO_SCRIPT.map((line, idx) => html`
                <div class="script-row" style="display:flex; align-items:center; margin-bottom:8px; padding:4px; background:${this.runningScriptLine === idx ? '#eef' : '#fff'}">
                  <button ?disabled=${this.runningScriptLine !== null} @click=${() => this.runScript(idx)} style="margin-right:10px">
                    ${this.runningScriptLine === idx ? 'Running...' : 'Run'}
                  </button>
                  <code>${idx + 1}. ${line}</code>
                </div>
              `)}
            </div>

            ${this.scriptLogs.length > 0 ? html`
              <hr/>
              <h3>Target Step Results</h3>
              ${this.scriptLogs.map(log => html`
                <div class="result-block" style="border:1px solid #ccc; padding:10px; margin-top:10px; border-radius:4px;">
                   <h4>Request</h4>
                   <pre style="white-space: pre-wrap; background:#f5f5f5; padding:8px; overflow:auto;">${this.formatLogValue(log.prompt_snapshot)}</pre>
                   <h4>Response</h4>
                   <pre style="white-space: pre-wrap; background:#f5f5f5; padding:8px; overflow:auto;">${this.formatLogValue(log.response_snapshot)}</pre>
                   <div><strong>Duration:</strong> ${log.duration_ms}ms | <strong>Mocked:</strong> ${log.mocked}</div>
                </div>
              `)}

              ${this.scriptFinalState ? html`
                <h4>Final Isolated State</h4>
                <pre style="font-size:0.8em; max-height:200px; overflow:auto;">${JSON.stringify(this.scriptFinalState, null, 2)}</pre>
              ` : ''}
            ` : ''}

          </div>
        ` : ''}

        ${local.settings.activeTab === 'results' ? html`
          <div class="debug-panel">
            <h3>IR Validation Errors</h3>
            ${local.validationErrors.length === 0 ? html`<p>No errors found.</p>` : html`
              <div class="errors-list">
                ${local.validationErrors.map(err => html`
                  <div class="error-item" style="color: ${err.severity === 'error' ? 'red' : 'orange'}; margin-bottom: 0.5rem;">
                    [${err.severity.toUpperCase()}] ${err.nodeId ? html`Node <strong>${err.nodeId}</strong>: ` : ''} ${err.message}
                  </div>
                `)}
              </div>
            `}

            <hr/>

            <h3>Compilation Results</h3>
            ${!local.compilationResult ? html`<p>Not compiled yet.</p>` : html`
              <div class="compilation-results">
                <h4>JavaScript (CPU Host)</h4>
                <pre style="background: #f8f8f8; padding: 0.5rem; overflow: auto; max-height: 300px;">${local.compilationResult.js}</pre>

                <h4>WGSL (GPU Shaders)</h4>
                ${Object.entries(local.compilationResult.wgsl).map(([id, code]) => html`
                  <div class="wgsl-block">
                    <h5>Function: ${id}</h5>
                    <pre style="background: #f0f0f0; padding: 0.5rem; overflow: auto; max-height: 300px;">${code}</pre>
                  </div>
                `)}
              </div>
            `}
          </div>
        ` : ''}
      </div>

      <div class="chat-interface">
        <div class="chat-history">
            ${chat_history.map(msg => html`
                <div class="msg ${msg.role}">
                    <strong>${msg.role}:</strong> ${msg.text}
                </div>
            `)}
        </div>
        <div class="input-area">
            <input
                class="chat-input"
                .value=${draftChat}
                @input=${(e: any) => appController.setDraftChat(e.target.value)}
                @keydown=${(e: any) => { if (e.key === 'Enter') this.handleSend(); }}
                placeholder="Type a message..."
            />
            <ui-button @click=${() => this.handleSend()}>
                Send <ui-icon icon="la-paper-plane"></ui-icon>
            </ui-button>
        </div>
      </div>
    `;
  }
}