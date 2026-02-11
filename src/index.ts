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
import './views/components/ui-ir-widget';
import './views/components/ui-viewport';
import './views/components/ui-inspector';

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
import { ALL_EXAMPLES } from './domain/example-ir';
import { runScriptDebug } from './debug/script-runner';
import { LLMLogEntry } from './domain/types';
import { ZipFileSystem } from './metal/virtual-fs';
import { packageFFGLPlugin } from './metal/ffgl-packager';

@customElement('nano-app')
export class App extends MobxLitElement {
  @state() scriptLogs: LLMLogEntry[] = [];
  @state() scriptFinalState: any = null;
  @state() runningScriptLine: number | null = null;
  @state() isGlobalDragging = false;
  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        width: 100vw;
        background-color: var(--app-bg);
        color: var(--app-text-main);
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
        background: var(--app-header-bg);
        border-bottom: 1px solid var(--app-border);
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
        background: #000;
        border-bottom: 1px solid #ccc;
      }

      .chat-interface {
        height: 200px;
        display: flex;
        flex-direction: column;
        border-top: 1px solid var(--app-border);
        background: #1e1e1e;
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
        padding: 0.5rem;
        border-radius: 4px;
        max-width: 80%;
      }
      .msg.user { align-self: flex-end; background: #0c4a6e; }
      .msg.assistant { align-self: flex-start; }

      .input-area {
        display: flex;
        padding: 0.5rem;
        gap: 0.5rem;
        background: #181818;
      }

      .chat-input {
        flex: 1;
        padding: 0.5rem;
        background: #2a2a2a;
        color: #e0e0e0;
        border: 1px solid #444;
        border-radius: 4px;
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
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }

      .state-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-right: 1px solid var(--app-border);
        background: var(--app-bg);
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
        border-bottom: 2px solid var(--app-border);
        padding-bottom: 0.5rem;
      }

      .debug-panel pre {
        background: #1a1a1a;
        border: 1px solid var(--app-border);
        padding: 1rem;
        border-radius: 4px;
        font-size: 0.85rem;
        flex: 1;
        color: #ccc;
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

    // Wait for settings and DB to load, then restore transport
    await appState.initialized;
    await appController.restoreTransportState();

    // Global drag and drop setup
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
    // Only leave if we actually left the window
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
      this.scriptLogs = [{
        id: 'unknown',
        timestamp: Date.now(),
        duration_ms: 0,
        type: 'error',
        prompt_snapshot: '',
        response_snapshot: e?.toString() ?? 'unknown error'
      }];
      this.scriptFinalState = undefined;
    } finally {
      this.runningScriptLine = null;
    }
  }

  loadExample(ir: typeof appState.database.ir) {
    appController.mutate('Load Example', 'user', (draft) => {
      draft.ir = JSON.parse(JSON.stringify(ir));
    }, { needsCompile: true });
  }

  async handleSend() {
    const text = appState.local.draftChat;
    if (!text.trim()) return;
    appController.setDraftChat('');
    await chatHandler.handleUserMessage(text);
  }

  async handleDownloadZip() {
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

      // Cleanup
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (e) {
      console.error('Failed to package plugin:', e);
    }
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
            <div class="tab ${local.settings.activeTab === 'live' ? 'active' : ''}" @click=${() => appController.setActiveTab('live')}>Live</div>
            <div class="tab ${local.settings.activeTab === 'ir' ? 'active' : ''}" @click=${() => appController.setActiveTab('ir')}>IR Code</div>
            <div class="tab ${local.settings.activeTab === 'raw_code' ? 'active' : ''}" @click=${() => appController.setActiveTab('raw_code')}>Raw Code</div>
            <div class="tab ${local.settings.activeTab === 'state' ? 'active' : ''}" @click=${() => appController.setActiveTab('state')}>State</div>
            <div class="tab ${local.settings.activeTab === 'script' ? 'active' : ''}" @click=${() => appController.setActiveTab('script')}>Script</div>
            <div class="tab ${local.settings.activeTab === 'logs' ? 'active' : ''}" @click=${() => appController.setActiveTab('logs')}>LLM Logs</div>
          </div>
          <div class="divider" style="width: 1px; background: #333; margin: 0 0.5rem;"></div>
          <div class="actions" style="display: flex; gap: 0.5rem;">
            <div class="divider" style="width: 1px; background: #333; margin: 0 0.5rem;"></div>
            <ui-button icon="la-play" square @click=${() => appController.play()} .variant=${appController.runtime.transportState === 'playing' ? 'primary' : 'outline'} title="Play"></ui-button>
            <ui-button icon="la-pause" square @click=${() => appController.pause()} .variant=${appController.runtime.transportState === 'paused' ? 'primary' : 'outline'} title="Pause"></ui-button>
            <ui-button icon="la-stop" square @click=${() => appController.stop()} .variant=${appController.runtime.transportState === 'stopped' ? 'primary' : 'outline'} title="Stop"></ui-button>
            <ui-button icon="la-step-forward" square @click=${() => appController.runtime.step()} title="Step"></ui-button>
            <ui-button icon="la-download" square @click=${() => this.handleDownloadZip()} title="Download Build ZIP"></ui-button>
          </div>
          <div class="divider" style="width: 1px; background: #333; margin: 0 0.5rem;"></div>
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

        ${local.settings.activeTab === 'ir' ? html`
          <ui-ir-widget .ir=${database.ir}></ui-ir-widget>
        ` : ''}

        ${local.settings.activeTab === 'logs' ? html`
          <div class="debug-panel">
            <h3>Latest LLM Logs (Live)</h3>
            <div class="logs-list">
              ${local.llmLogs.map(log => html`
                <div class="log-entry" style="margin-bottom: 2rem; border-bottom: 1px solid #333; padding-bottom: 1rem;">
                  <div style="font-size:0.8em; color:#888; margin-bottom: 0.5rem;">
                    <strong>ID:</strong> ${log.id} |
                    <strong>Turn:</strong> ${log.turn_index || 1} |
                    <strong>Duration:</strong> ${log.duration_ms}ms |
                    <strong>Mocked:</strong> ${log.mocked}
                  </div>

                  <div style="margin-bottom: 0.5rem;"><strong>Prompt:</strong></div>
                  <pre style="white-space: pre-wrap; background: rgba(255, 243, 162, 0.06); padding: 0.5rem; max-height: 200px; overflow: auto; border: 1px solid #444;">${this.formatLogValue(log.prompt_snapshot)}</pre>

                  <div style="margin-bottom: 0.5rem;"><strong>Response:</strong></div>
                  <pre style="white-space: pre-wrap; background: #68dcff1e; padding: 0.5rem; max-height: 400px; overflow: auto; border: 1px solid #444;">${this.formatLogValue(log.response_snapshot)}</pre>
                </div>
              `)}
            </div>
          </div>
        ` : ''}

        ${local.settings.activeTab === 'script' ? html`
          <div class="debug-panel">
            <h3>Examples</h3>
            <div class="examples-list" style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 2rem;">
              ${Object.entries(ALL_EXAMPLES).map(([key, example]) => html`
                <ui-button @click=${() => this.loadExample(example)}>
                  ${example.meta.name || key}
                </ui-button>
              `)}
            </div>

            <h3>Demo Script Debugger</h3>
            <p>Run script step-by-step in an isolated environment. Pre-requisite steps are always mocked. Target step uses current "Mock LLM" toggle.</p>

            <div class="script-list">
              ${DEMO_SCRIPT.map((line, idx) => html`
                <div class="script-row" style="display:flex; align-items:center; margin-bottom:8px; padding:4px; background:${this.runningScriptLine === idx ? '#444' : 'transparent'}; border: 1px solid ${this.runningScriptLine === idx ? 'var(--color-primary)' : '#333'}">
                  <ui-button ?disabled=${this.runningScriptLine !== null} @click=${() => this.runScript(idx)} style="margin-right:10px">
                    ${this.runningScriptLine === idx ? 'Running...' : 'Run Line'}
                  </ui-button>
                  <code>#${idx + 1}: ${Array.isArray(line) ? line[0].text.substring(0, 50) + '...' : line}</code>
                </div>
              `)}
            </div>

            ${this.scriptLogs.length > 0 ? html`
              <hr style="border: none; border-top: 1px solid #333; margin: 2rem 0;"/>
              <h3>Target Step Interactions (${this.scriptLogs.length} turns)</h3>
              ${this.scriptLogs.map(log => html`
                <div class="result-block" style="border:1px solid #444; padding:15px; margin-top:15px; border-radius:4px; background: #1a1a1a;">
                   <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; border-bottom: 1px solid #333; padding-bottom: 0.5rem;">
                     <strong>Step Turn #${log.turn_index || 1}</strong>
                     <span style="font-size: 0.8rem; color: #888;">${log.duration_ms}ms | Mocked: ${log.mocked}</span>
                   </div>

                   ${log.system_instruction_snapshot && (log.turn_index === 1) ? html`
                    <div style="margin-bottom: 0.5rem; color: #aaa; font-size: 0.9rem;">System Instruction:</div>
                    <pre style="white-space: pre-wrap; background: #0a0a0a; padding:8px; overflow:auto; max-height: 150px; font-size: 0.8rem; border: 1px solid #222; color: #666;">${this.formatLogValue(log.system_instruction_snapshot)}</pre>
                   ` : ''}

                   <div style="margin-bottom: 0.5rem; color: #aaa; font-size: 0.9rem;">Request (Prompt/Feedback):</div>
                   <pre style="white-space: pre-wrap; background: #0a0a0a; padding:8px; overflow:auto; max-height: 250px; border: 1px solid #222;">${this.formatLogValue(log.prompt_snapshot)}</pre>

                   <div style="margin-bottom: 0.5rem; color: #aaa; font-size: 0.9rem;">Response (Text/Tools):</div>
                   <pre style="white-space: pre-wrap; background: #0a0a0a; padding:8px; overflow:auto; max-height: 350px; border: 1px solid #222; color: var(--color-primary-light);">${this.formatLogValue(log.response_snapshot)}</pre>
                </div>
              `)}

              ${this.scriptFinalState ? html`
                <h4>Final Isolated State</h4>
                <pre style="font-size:0.8em; max-height:200px; overflow:auto;">${JSON.stringify(this.scriptFinalState, null, 2)}</pre>
              ` : ''}
            ` : ''}

          </div>
        ` : ''}

        ${local.settings.activeTab === 'raw_code' ? html`
          <div class="debug-panel" style="flex: 1; overflow: auto; padding: 1rem;">
            <div class="toolbar" style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
                <ui-button @click=${() => appController.debugValidateCurrentIR()}>Validate</ui-button>
                <ui-button @click=${() => appController.compileCurrentIR()}>Compile</ui-button>
            </div>
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

            <hr style="border: none; border-top: 1px solid #333; margin: 1rem 0;"/>

            <h3>Compilation Results</h3>
            ${!local.compilationResult ? html`<p>Not compiled yet.</p>` : html`
              <div class="compilation-results">
                <h4>JavaScript (CPU Host)</h4>
                <pre style="background: #080808; padding: 0.5rem; overflow: auto; max-height: 300px;">${local.compilationResult.js}</pre>
                <pre style="background: #080808; padding: 0.5rem; overflow: auto; max-height: 300px;">${local.compilationResult.jsInit}</pre>

                <h4>WGSL (GPU Shaders)</h4>
                ${Object.entries(local.compilationResult.wgsl).map(([id, code]) => html`
                  <div class="wgsl-block">
                    <h5>Function: ${id}</h5>
                    <pre style="background: #0f0f0f; padding: 0.5rem; overflow: auto; max-height: 300px;">${code}</pre>
                  </div>
                `)}
              </div>
            `}
          </div>
        ` : ''}

        ${local.settings.activeTab === 'live' ? html`
          <div class="results-view" style="display: flex; flex-direction: row; height: 100%; overflow: hidden;">
            <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid #333;">
                <ui-viewport .runtime=${appController.runtime} style="flex: 1; min-height: 300px;"></ui-viewport>
            </div>
            <ui-inspector .runtime=${appController.runtime}></ui-inspector>
          </div>
        ` : ''}
      </div>

      <div class="global-drop-zone ${this.isGlobalDragging ? 'active' : ''}">
        Drop to Load into First Slot
      </div>

      <div class="chat-interface">
        <div class="chat-history">
            ${chat_history.map(msg => html`
                <div class="msg ${msg.role}">
                    <strong>${msg.role}:</strong> ${msg.role === 'tool-response' ? JSON.stringify(msg.data, undefined, 2) : msg.text}
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