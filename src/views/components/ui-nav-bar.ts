import './ui-icon';
import { MobxLitElement } from '../mobx-lit-element';
import { css, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appState } from '../../domain/state';
import { appController } from '../../state/controller';
import { AppSettings } from '../../domain/types';

interface NavTab {
  id: AppSettings['activeTab'];
  icon: string;
  label: string;
  devOnly: boolean;
}

const TABS: NavTab[] = [
  { id: 'dashboard', icon: 'la-sliders-h', label: 'Dashboard', devOnly: false },
  { id: 'ir',        icon: 'la-project-diagram', label: 'IR Code', devOnly: true },
  { id: 'raw_code',  icon: 'la-code', label: 'Raw Code', devOnly: true },
  { id: 'state',     icon: 'la-database', label: 'State', devOnly: true },
  { id: 'script',    icon: 'la-scroll', label: 'Script', devOnly: true },
  { id: 'logs',      icon: 'la-clipboard-list', label: 'LLM Logs', devOnly: true },
  { id: 'settings',  icon: 'la-cog', label: 'Settings', devOnly: false },
];

@customElement('ui-nav-bar')
export class UiNavBar extends MobxLitElement {
  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        width: 48px;
        box-sizing: border-box;
        background: #161616;
        border-right: 1px solid var(--app-border);
        flex-shrink: 0;
        overflow: hidden;
      }

      .tabs {
        display: flex;
        flex-direction: column;
        flex: 1;
      }

      .spacer {
        flex: 1;
      }

      .tab {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 48px;
        height: 48px;
        cursor: pointer;
        opacity: 0.5;
        transition: opacity 0.15s, background 0.15s;
        position: relative;
      }

      .tab:hover {
        opacity: 0.8;
        background: rgba(255, 255, 255, 0.05);
      }

      .tab.active {
        opacity: 1;
        background: rgba(255, 255, 255, 0.08);
      }

      .tab.active::before {
        content: '';
        position: absolute;
        left: 0;
        top: 8px;
        bottom: 8px;
        width: 3px;
        background: var(--color-emerald-500);
        border-radius: 0 2px 2px 0;
      }

      ui-icon {
        --icon-size: 1.25rem;
      }
    `
  ];

  render() {
    const settings = appState.local.settings;
    const visibleTabs = TABS.filter(t => !t.devOnly || settings.devMode);

    // Split: settings goes to bottom
    const topTabs = visibleTabs.filter(t => t.id !== 'settings');
    const bottomTabs = visibleTabs.filter(t => t.id === 'settings');

    return html`
      <div class="tabs">
        ${topTabs.map(tab => html`
          <div
            class="tab ${settings.activeTab === tab.id ? 'active' : ''}"
            title=${tab.label}
            @click=${() => appController.toggleLeftPanel(tab.id)}
          >
            <ui-icon icon=${tab.icon}></ui-icon>
          </div>
        `)}
        <div class="spacer"></div>
        ${bottomTabs.map(tab => html`
          <div
            class="tab ${settings.activeTab === tab.id ? 'active' : ''}"
            title=${tab.label}
            @click=${() => appController.toggleLeftPanel(tab.id)}
          >
            <ui-icon icon=${tab.icon}></ui-icon>
          </div>
        `)}
      </div>
    `;
  }
}
