import './ui-button';
import { MobxLitElement } from '../mobx-lit-element';
import { css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appController } from '../../state/controller';

@customElement('ui-title-bar')
export class UiTitleBar extends MobxLitElement {
  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        justify-content: space-between;
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
      }

      .center {
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }

      .right {
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }

      .divider {
        width: 1px;
        height: 24px;
        background: var(--app-border);
        margin: 0 0.25rem;
      }
    `
  ];

  render() {
    return html`
      <div class="left">Nano FFGLify</div>

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
        <ui-button icon="la-download" square @click=${() => this.dispatchEvent(new CustomEvent('download-zip', { bubbles: true, composed: true }))} title="Download Build ZIP"></ui-button>
      </div>
    `;
  }
}
