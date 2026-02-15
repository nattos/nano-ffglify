import './ui-button';
import './ui-ir-widget';
import './ui-inspector';
import './ui-settings-panel';
import { MobxLitElement } from '../mobx-lit-element';
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appState } from '../../domain/state';
import { appController } from '../../state/controller';
import { DEMO_SCRIPT } from '../../domain/mock-responses';
import { ALL_EXAMPLES } from '../../domain/example-ir';
import { runScriptDebug } from '../../debug/script-runner';
import { LLMLogEntry } from '../../domain/types';
import { runInAction } from 'mobx';

const TAB_LABELS: Record<string, string> = {
  dashboard: 'Inspector',
  ir: 'IR Code',
  raw_code: 'Raw Code',
  state: 'State',
  script: 'Script',
  logs: 'LLM Logs',
  settings: 'Settings',
};

@customElement('ui-left-panel')
export class UiLeftPanel extends MobxLitElement {
  @state() private scriptLogs: LLMLogEntry[] = [];
  @state() private scriptFinalState: any = null;
  @state() private runningScriptLine: number | null = null;

  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        background: var(--app-bg);
        border-right: 1px solid var(--app-border);
        overflow: hidden;
      }

      .panel-header {
        display: flex;
        align-items: center;
        padding: 0.75rem 0.5rem;
        flex-shrink: 0;
      }

      .panel-title {
        font-size: 0.75rem;
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--app-text-muted);
      }

      .panel-body {
        flex: 1;
        overflow: auto;
        display: flex;
        flex-direction: column;
      }

      .scroll-content {
        display: flex;
        flex-direction: column;
        padding: 0.5rem;
        gap: 0.75rem;
      }

      .section-title {
        margin: 0;
        font-size: 0.75rem;
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--app-text-muted);
      }

      pre {
        background: #1a1a1a;
        border: 1px solid var(--app-border);
        padding: 0.5rem;
        border-radius: 4px;
        font-size: 0.75rem;
        color: #ccc;
        white-space: pre-wrap;
        word-break: break-all;
        overflow: auto;
        margin: 0;
      }

      ui-inspector {
        width: 100%;
        border-left: none;
      }

      ui-ir-widget {
        flex: 1;
      }

      ui-settings-panel {
        flex: 1;
      }
    `
  ];

  private formatLogValue(value: string) {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  private async runScript(index: number) {
    this.runningScriptLine = index;
    this.scriptLogs = [];
    this.scriptFinalState = null;

    try {
      const useMock = appState.local.settings.useMockLLM;
      const res = await runScriptDebug(index, DEMO_SCRIPT, useMock);
      runInAction(() => {
        this.scriptLogs = res.logs;
        this.scriptFinalState = res.finalState;
      });
    } catch (e) {
      console.error(e);
      this.scriptLogs = [{
        id: 'unknown', timestamp: Date.now(), duration_ms: 0,
        type: 'error', prompt_snapshot: '',
        response_snapshot: e?.toString() ?? 'unknown error'
      }];
      this.scriptFinalState = undefined;
    } finally {
      this.runningScriptLine = null;
    }
  }

  private loadExample(ir: typeof appState.database.ir) {
    appController.mutate('Load Example', 'user', (draft) => {
      draft.ir = JSON.parse(JSON.stringify(ir));
    }, { needsCompile: true });
  }

  render() {
    const { activeTab } = appState.local.settings;
    const title = TAB_LABELS[activeTab] ?? activeTab;

    return html`
      <div class="panel-header">
        <span class="panel-title">${title}</span>
      </div>
      <div class="panel-body">
        ${activeTab === 'dashboard' ? this.renderDashboard() : nothing}
        ${activeTab === 'ir' ? this.renderIR() : nothing}
        ${activeTab === 'raw_code' ? this.renderRawCode() : nothing}
        ${activeTab === 'state' ? this.renderState() : nothing}
        ${activeTab === 'script' ? this.renderScript() : nothing}
        ${activeTab === 'logs' ? this.renderLogs() : nothing}
        ${activeTab === 'settings' ? this.renderSettings() : nothing}
      </div>
    `;
  }

  private renderDashboard() {
    return html`<ui-inspector .runtime=${appController.runtime}></ui-inspector>`;
  }

  private renderIR() {
    return html`<ui-ir-widget .ir=${appState.database.ir}></ui-ir-widget>`;
  }

  private renderRawCode() {
    const { validationErrors, compilationResult } = appState.local;
    return html`
      <div class="scroll-content">
        <div style="display: flex; gap: 0.5rem;">
          <ui-button @click=${() => appController.debugValidateCurrentIR()}>Validate</ui-button>
          <ui-button @click=${() => appController.compileCurrentIR()}>Compile</ui-button>
        </div>
        <h3 class="section-title">Validation Errors</h3>
        ${validationErrors.length === 0 ? html`<p style="margin:0; font-size:0.8rem; color:var(--app-text-muted);">No errors found.</p>` : html`
          <div>
            ${validationErrors.map(err => html`
              <div style="color: ${err.severity === 'error' ? 'red' : 'orange'}; margin-bottom: 0.5rem; font-size: 0.8rem;">
                [${err.severity.toUpperCase()}] ${err.nodeId ? html`Node <strong>${err.nodeId}</strong>: ` : ''} ${err.message}
              </div>
            `)}
          </div>
        `}

        <h3 class="section-title">Compilation Results</h3>
        ${!compilationResult ? html`<p style="margin:0; font-size:0.8rem; color:var(--app-text-muted);">Not compiled yet.</p>` : html`
          <div>
            <h4 style="margin:0.5rem 0 0.25rem; font-size:0.8rem;">JavaScript (CPU Host)</h4>
            <pre style="max-height: 300px;">${compilationResult.js}</pre>
            <pre style="max-height: 300px; margin-top:0.5rem;">${compilationResult.jsInit}</pre>

            <h4 style="margin:0.75rem 0 0.25rem; font-size:0.8rem;">WGSL (GPU Shaders)</h4>
            ${Object.entries(compilationResult.wgsl).map(([id, code]) => html`
              <div>
                <h5 style="margin:0.5rem 0 0.25rem; color:#666; font-size:0.75rem;">Function: ${id}</h5>
                <pre style="max-height: 300px;">${code}</pre>
              </div>
            `)}
          </div>
        `}
      </div>
    `;
  }

  private renderState() {
    const { database, local } = appState;
    const displayState = {
      database,
      local: { ...local, llmLogs: `[${local.llmLogs.length} entries hidden]` }
    };
    return html`
      <div class="scroll-content">
        <pre>${JSON.stringify(displayState, null, 2)}</pre>
      </div>
    `;
  }

  private renderScript() {
    return html`
      <div class="scroll-content">
        <h3 class="section-title">Examples</h3>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          ${Object.entries(ALL_EXAMPLES).map(([key, example]) => html`
            <ui-button @click=${() => this.loadExample(example)}>
              ${example.meta.name || key}
            </ui-button>
          `)}
        </div>

        <h3 class="section-title">Demo Script Debugger</h3>
        <p style="font-size: 0.75rem; color: var(--app-text-muted); margin:0;">Run script step-by-step in an isolated environment.</p>

        <div>
          ${DEMO_SCRIPT.map((line, idx) => html`
            <div style="display:flex; align-items:center; margin-bottom:4px; padding:4px; background:${this.runningScriptLine === idx ? '#444' : 'transparent'}; border: 1px solid ${this.runningScriptLine === idx ? 'var(--color-emerald-500)' : '#333'}; border-radius: 4px;">
              <ui-button ?disabled=${this.runningScriptLine !== null} @click=${() => this.runScript(idx)} style="margin-right:8px">
                ${this.runningScriptLine === idx ? 'Running...' : 'Run'}
              </ui-button>
              <code style="font-size: 0.7rem;">#${idx + 1}: ${Array.isArray(line) ? line[0].text.substring(0, 50) + '...' : line}</code>
            </div>
          `)}
        </div>

        ${this.scriptLogs.length > 0 ? html`
          <h3 class="section-title">Target Step (${this.scriptLogs.length} turns)</h3>
          ${this.scriptLogs.map(log => html`
            <div style="border:1px solid #444; padding:0.5rem; border-radius:4px; background: #1a1a1a;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid #333;">
                <strong style="font-size:0.8rem;">Turn #${log.turn_index || 1}</strong>
                <span style="font-size: 0.7rem; color: #888;">${log.duration_ms}ms | Mocked: ${log.mocked}</span>
              </div>
              ${log.system_instruction_snapshot && (log.turn_index === 1) ? html`
                <div style="margin-bottom: 0.25rem; color: #aaa; font-size: 0.75rem;">System Instruction:</div>
                <pre style="max-height: 150px; font-size: 0.7rem; color: #666;">${this.formatLogValue(log.system_instruction_snapshot)}</pre>
              ` : nothing}
              <div style="margin-bottom: 0.25rem; color: #aaa; font-size: 0.75rem;">Request:</div>
              <pre style="max-height: 250px;">${this.formatLogValue(log.prompt_snapshot)}</pre>
              <div style="margin-bottom: 0.25rem; color: #aaa; font-size: 0.75rem;">Response:</div>
              <pre style="max-height: 350px; color: var(--color-emerald-500);">${this.formatLogValue(log.response_snapshot)}</pre>
            </div>
          `)}
          ${this.scriptFinalState ? html`
            <h3 class="section-title">Final Isolated State</h3>
            <pre style="font-size:0.7rem; max-height:200px;">${JSON.stringify(this.scriptFinalState, null, 2)}</pre>
          ` : nothing}
        ` : nothing}
      </div>
    `;
  }

  private renderLogs() {
    const { llmLogs } = appState.local;
    return html`
      <div class="scroll-content">
        ${llmLogs.map(log => html`
          <div style="padding-bottom: 0.75rem; border-bottom: 1px solid #333;">
            <div style="font-size:0.7rem; color:#888; margin-bottom: 0.25rem;">
              <strong>ID:</strong> ${log.id} |
              <strong>Turn:</strong> ${log.turn_index || 1} |
              <strong>Duration:</strong> ${log.duration_ms}ms |
              <strong>Mocked:</strong> ${log.mocked}
            </div>
            <div style="margin-bottom: 0.25rem; font-size:0.75rem;"><strong>Prompt:</strong></div>
            <pre style="background: rgba(255, 243, 162, 0.06); max-height: 200px;">${this.formatLogValue(log.prompt_snapshot)}</pre>
            <div style="margin-bottom: 0.25rem; font-size:0.75rem;"><strong>Response:</strong></div>
            <pre style="background: #68dcff1e; max-height: 400px;">${this.formatLogValue(log.response_snapshot)}</pre>
          </div>
        `)}
      </div>
    `;
  }

  private renderSettings() {
    return html`<ui-settings-panel></ui-settings-panel>`;
  }
}
