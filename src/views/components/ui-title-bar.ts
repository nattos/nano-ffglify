import './ui-button';
import { MobxLitElement } from '../mobx-lit-element';
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appController } from '../../state/controller';
import { appState } from '../../domain/state';

@customElement('ui-title-bar')
export class UiTitleBar extends MobxLitElement {
  @state() private showExportPanel = false;

  private outsideClickHandler = (e: MouseEvent) => {
    const path = e.composedPath();
    if (!path.includes(this)) {
      this.showExportPanel = false;
    }
  };

  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        padding: 0 1rem;
        height: 48px;
        background: var(--app-header-bg);
        border-bottom: 1px solid var(--app-border);
        flex-shrink: 0;
      }

      .left {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: bold;
        font-size: 1rem;
        white-space: nowrap;
        color: var(--app-text-muted);
        min-width: 0;
      }

      .app-name {
        flex-shrink: 0;
      }

      .workspace-name {
        font-weight: normal;
        font-size: 0.85rem;
        opacity: 0.6;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .workspace-sep {
        opacity: 0.3;
        flex-shrink: 0;
      }

      .center {
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }

      .right {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.25rem;
        position: relative;
      }

      .divider {
        width: 1px;
        height: 24px;
        background: var(--app-border);
        margin: 0 0.25rem;
      }

      .export-panel {
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 4px;
        background: var(--app-panel-bg, #1e1e1e);
        border: 1px solid var(--app-border);
        border-radius: 10px;
        padding: 16px;
        z-index: 100;
        width: 280px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .export-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .export-section + .export-section {
        border-top: 1px solid var(--app-border);
        padding-top: 12px;
      }

      .section-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--app-text-main);
      }

      .section-desc {
        font-size: 0.75rem;
        color: var(--app-text-muted);
        line-height: 1.4;
      }

      .section-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        color: var(--app-text-main);
        font-size: 0.75rem;
        font-weight: 600;
        font-family: inherit;
        border: 1px solid var(--app-border);
        background: transparent;
        transition: all 0.15s;
        width: 100%;
      }

      .section-btn:hover {
        background: rgba(255, 255, 255, 0.06);
        border-color: var(--app-text-muted);
      }

      .section-btn:active {
        transform: translateY(1px);
      }

      .section-btn i {
        font-size: 1rem;
      }
    `
  ];

  private toggleExportPanel() {
    this.showExportPanel = !this.showExportPanel;
    if (this.showExportPanel) {
      requestAnimationFrame(() => {
        window.addEventListener('click', this.outsideClickHandler, true);
      });
    } else {
      window.removeEventListener('click', this.outsideClickHandler, true);
    }
  }

  private handleExportFFGL() {
    this.showExportPanel = false;
    window.removeEventListener('click', this.outsideClickHandler, true);
    this.dispatchEvent(new CustomEvent('download-zip', { bubbles: true, composed: true }));
  }

  private handleExportShader() {
    this.showExportPanel = false;
    window.removeEventListener('click', this.outsideClickHandler, true);
    this.dispatchEvent(new CustomEvent('download-shader-json', { bubbles: true, composed: true }));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('click', this.outsideClickHandler, true);
  }

  render() {
    const ws = appState.local.workspaces.find(w => w.id === appController.activeWorkspaceId);

    return html`
      <div class="left">
        <span class="app-name">Nano FFGLify</span>
        ${ws ? html`<span class="workspace-sep">/</span><span class="workspace-name">${ws.name}</span>` : nothing}
      </div>

      <div class="center">
        <ui-button icon="la-play" square @click=${() => appController.play()} .variant=${appController.runtime.transportState === 'playing' ? 'primary' : 'outline'} title="Play"></ui-button>
        <ui-button icon="la-pause" square @click=${() => appController.pause()} .variant=${appController.runtime.transportState === 'paused' ? 'primary' : 'outline'} title="Pause"></ui-button>
        <ui-button icon="la-stop" square @click=${() => appController.stop()} .variant=${appController.runtime.transportState === 'stopped' ? 'primary' : 'outline'} title="Stop"></ui-button>
        <ui-button icon="la-step-forward" square @click=${() => appController.runtime.step()} title="Step"></ui-button>
        <div class="divider"></div>
        <ui-button icon="la-undo" square @click=${() => appController.undo()} title="Undo"></ui-button>
        <ui-button icon="la-redo" square @click=${() => appController.redo()} title="Redo"></ui-button>
      </div>

      <div class="right">
        <ui-button icon="la-external-link-alt" variant="ghost" @click=${() => this.toggleExportPanel()} title="Export">Export</ui-button>
        ${this.showExportPanel ? html`
          <div class="export-panel">
            <div class="export-section">
              <div class="section-title">FFGL Plugin</div>
              <div class="section-desc">Native macOS plugin for Resolume, VDMX, and other VJ software. Unzip and run the .sh script, then copy the .bundle to your plugins folder.</div>
              <button class="section-btn" @click=${() => this.handleExportFFGL()}>
                <i class="las la-download"></i> Download FFGL
              </button>
            </div>
            <div class="export-section">
              <div class="section-title">Shader</div>
              <div class="section-desc">Portable shader graph as JSON. Share with others, or drag and drop back into Nano FFGLify to import.</div>
              <button class="section-btn" @click=${() => this.handleExportShader()}>
                <i class="las la-download"></i> Download Shader
              </button>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }
}
