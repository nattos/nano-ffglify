import './ui-button';
import './ui-icon';
import { MobxLitElement } from '../mobx-lit-element';
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appState } from '../../domain/state';
import { appController } from '../../state/controller';
import { WorkspaceIndexEntry } from '../../domain/types';

function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

@customElement('ui-workspace-panel')
export class UiWorkspacePanel extends MobxLitElement {
  @state() private renamingId: string | null = null;
  @state() private renameValue = '';
  @state() private confirmingDeleteId: string | null = null;

  static readonly styles = [
    globalStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        color: var(--app-text-main);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: 0 0.5rem 0.5rem;
        flex-shrink: 0;
      }

      .list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 0 0.25rem;
      }

      .workspace-entry {
        display: flex;
        align-items: stretch;
        padding: 0.5rem;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.1s;
        border-left: 3px solid transparent;
        gap: 0.5rem;
      }

      .workspace-entry:hover {
        background: rgba(255, 255, 255, 0.05);
      }

      .workspace-entry.active {
        border-left-color: var(--color-emerald-500);
        background: rgba(255, 255, 255, 0.08);
      }

      .workspace-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .workspace-name {
        font-size: 0.85rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .workspace-entry.active .workspace-name {
        font-weight: bold;
      }

      .workspace-meta {
        font-size: 0.7rem;
        color: var(--app-text-muted);
      }

      .fork-info {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 0.65rem;
        color: var(--app-text-muted);
        opacity: 0.8;
      }

      .fork-source {
        cursor: pointer;
        text-decoration: underline;
        text-decoration-style: dotted;
      }

      .fork-source:hover {
        color: var(--app-text-main);
      }

      .fork-source.missing {
        text-decoration: line-through;
        cursor: default;
        opacity: 0.5;
      }

      .workspace-actions {
        display: flex;
        gap: 2px;
        opacity: 0;
        transition: opacity 0.1s;
        flex-shrink: 0;
        align-items: flex-start;
      }

      .workspace-entry:hover .workspace-actions {
        opacity: 1;
      }

      .rename-input {
        font-size: 0.85rem;
        background: #1a1a1a;
        border: 1px solid var(--color-emerald-500);
        color: var(--app-text-main);
        border-radius: 3px;
        padding: 2px 4px;
        outline: none;
        width: 100%;
        font-family: inherit;
      }

      .action-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        background: none;
        color: var(--app-text-muted);
        cursor: pointer;
        border-radius: 3px;
        font-size: 0.75rem;
        padding: 0;
      }

      .action-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: var(--app-text-main);
      }

      .action-btn.delete:hover {
        color: #f87171;
      }

      .confirm-delete {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        flex-shrink: 0;
      }

      .confirm-label {
        font-size: 0.7rem;
        color: #f87171;
        white-space: nowrap;
      }

      .confirm-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 22px;
        border: 1px solid;
        background: none;
        cursor: pointer;
        border-radius: 3px;
        font-size: 0.65rem;
        padding: 0 0.35rem;
        font-family: inherit;
      }

      .confirm-btn.yes {
        color: #f87171;
        border-color: #f87171;
      }

      .confirm-btn.yes:hover {
        background: rgba(248, 113, 113, 0.15);
      }

      .confirm-btn.no {
        color: var(--app-text-muted);
        border-color: var(--app-border);
      }

      .confirm-btn.no:hover {
        background: rgba(255, 255, 255, 0.1);
      }
    `
  ];

  private get busy() {
    return appState.local.llmBusy;
  }

  private async handleCreate() {
    if (this.busy) return;
    const id = await appController.createWorkspace();
    await appController.switchWorkspace(id);
  }

  private async handleSwitch(id: string) {
    if (this.busy) return;
    if (id === appController.activeWorkspaceId) return;
    await appController.switchWorkspace(id);
  }

  private async handleFork(e: Event, id: string) {
    e.stopPropagation();
    if (this.busy) return;
    await appController.forkWorkspace(id);
  }

  private handleDeleteClick(e: Event, id: string) {
    e.stopPropagation();
    if (this.busy) return;
    this.confirmingDeleteId = id;
  }

  private async confirmDelete(e: Event) {
    e.stopPropagation();
    if (!this.confirmingDeleteId) return;
    const id = this.confirmingDeleteId;
    this.confirmingDeleteId = null;
    await appController.deleteWorkspace(id);
  }

  private cancelDelete(e: Event) {
    e.stopPropagation();
    this.confirmingDeleteId = null;
  }

  private async handleGoToSource(e: Event, sourceId: string) {
    e.stopPropagation();
    if (this.busy) return;
    // Check if the source workspace still exists
    const exists = appState.local.workspaces.some(w => w.id === sourceId);
    if (!exists) return;
    await appController.switchWorkspace(sourceId);
  }

  private startRename(e: Event, entry: WorkspaceIndexEntry) {
    e.stopPropagation();
    this.renamingId = entry.id;
    this.renameValue = entry.name;
    // Focus the input after render
    this.updateComplete.then(() => {
      const input = this.shadowRoot?.querySelector('.rename-input') as HTMLInputElement;
      input?.focus();
      input?.select();
    });
  }

  private async commitRename() {
    if (this.renamingId && this.renameValue.trim()) {
      await appController.renameWorkspace(this.renamingId, this.renameValue.trim());
    }
    this.renamingId = null;
  }

  private handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      this.commitRename();
    } else if (e.key === 'Escape') {
      this.renamingId = null;
    }
  }

  render() {
    // Sort reverse chronologically by updatedAt, then createdAt as tiebreaker
    const workspaces = [...appState.local.workspaces].sort((a, b) =>
      b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
    );
    const activeId = appController.activeWorkspaceId;

    return html`
      <div class="header">
        <ui-button @click=${() => this.handleCreate()} ?disabled=${this.busy}>New</ui-button>
      </div>
      <div class="list">
        ${workspaces.map(ws => this.renderEntry(ws, activeId))}
      </div>
    `;
  }

  private renderEntry(ws: WorkspaceIndexEntry, activeId: string) {
    const isConfirmingDelete = this.confirmingDeleteId === ws.id;
    const sourceExists = ws.forkedFrom
      ? appState.local.workspaces.some(w => w.id === ws.forkedFrom!.sourceId)
      : false;

    return html`
      <div
        class="workspace-entry ${ws.id === activeId ? 'active' : ''}"
        @click=${() => this.handleSwitch(ws.id)}
      >
        <div class="workspace-info">
          ${this.renamingId === ws.id ? html`
            <input
              class="rename-input"
              .value=${this.renameValue}
              @input=${(e: Event) => this.renameValue = (e.target as HTMLInputElement).value}
              @blur=${() => this.commitRename()}
              @keydown=${(e: KeyboardEvent) => this.handleRenameKeydown(e)}
              @click=${(e: Event) => e.stopPropagation()}
            />
          ` : html`
            <div class="workspace-name" @dblclick=${(e: Event) => this.startRename(e, ws)}>${ws.name}</div>
          `}
          <div class="workspace-meta">${relativeTime(ws.updatedAt)}</div>
          ${ws.forkedFrom ? html`
            <div class="fork-info">
              <ui-icon icon="la-code-branch" style="--icon-size: 0.65rem;"></ui-icon>
              from
              <span
                class="fork-source ${sourceExists ? '' : 'missing'}"
                title="${sourceExists ? `Go to "${ws.forkedFrom.sourceName}"` : `"${ws.forkedFrom.sourceName}" (deleted)`}"
                @click=${sourceExists ? (e: Event) => this.handleGoToSource(e, ws.forkedFrom!.sourceId) : null}
              >${ws.forkedFrom.sourceName}</span>
              ${relativeTime(ws.forkedFrom.forkedAt)}
            </div>
          ` : nothing}
        </div>
        ${isConfirmingDelete ? html`
          <div class="confirm-delete" @click=${(e: Event) => e.stopPropagation()}>
            <span class="confirm-label">Delete?</span>
            <button class="confirm-btn yes" @click=${(e: Event) => this.confirmDelete(e)}>Yes</button>
            <button class="confirm-btn no" @click=${(e: Event) => this.cancelDelete(e)}>No</button>
          </div>
        ` : html`
          <div class="workspace-actions">
            <button class="action-btn" title="Fork" @click=${(e: Event) => this.handleFork(e, ws.id)}>
              <ui-icon icon="la-code-branch" style="--icon-size: 0.85rem;"></ui-icon>
            </button>
            <button class="action-btn delete" title="Delete" @click=${(e: Event) => this.handleDeleteClick(e, ws.id)}>
              <ui-icon icon="la-trash" style="--icon-size: 0.85rem;"></ui-icon>
            </button>
          </div>
        `}
      </div>
    `;
  }
}
