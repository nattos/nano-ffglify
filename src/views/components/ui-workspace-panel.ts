import './ui-button';
import './ui-icon';
import { MobxLitElement } from '../mobx-lit-element';
import { css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { globalStyles } from '../../styles';
import { appState } from '../../domain/state';
import { appController } from '../../state/controller';
import { WorkspaceIndexEntry } from '../../domain/types';
import { ALL_EXAMPLES } from '../../domain/example-ir';

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

type EditingField = { id: string; field: 'name' } | { id: string; field: 'comment' } | null;

@customElement('ui-workspace-panel')
export class UiWorkspacePanel extends MobxLitElement {
  @state() private editing: EditingField = null;
  @state() private editValue = '';
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

      .workspace-comment {
        font-size: 0.7rem;
        color: var(--app-text-muted);
        opacity: 0.8;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .workspace-entry.active .workspace-comment {
        white-space: pre-wrap;
        overflow: visible;
      }

      .comment-placeholder {
        font-size: 0.7rem;
        color: var(--app-text-muted);
        opacity: 0.3;
        font-style: italic;
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

      .edit-input {
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

      .edit-textarea {
        font-size: 0.7rem;
        background: #1a1a1a;
        border: 1px solid var(--color-emerald-500);
        color: var(--app-text-main);
        border-radius: 3px;
        padding: 2px 4px;
        outline: none;
        width: 100%;
        font-family: inherit;
        resize: vertical;
        min-height: 2.5em;
        field-sizing: content;
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

      .examples-divider {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 1rem 0.5rem 0.5rem;
        color: var(--app-text-muted);
        font-size: 0.7rem;
      }

      .examples-divider::before,
      .examples-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--app-border);
      }

      .examples-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 0 0.25rem;
      }

      .example-entry {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 0.5rem;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.1s;
        border-left: 3px solid transparent;
      }

      .example-entry:hover {
        background: rgba(255, 255, 255, 0.05);
      }

      .example-entry.active {
        border-left-color: var(--color-emerald-500);
        background: rgba(255, 255, 255, 0.08);
      }

      .example-name {
        font-size: 0.85rem;
      }

      .example-comment {
        font-size: 0.7rem;
        color: var(--app-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .example-entry.active .example-comment {
        white-space: pre-wrap;
        overflow: visible;
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
    const exists = appState.local.workspaces.some(w => w.id === sourceId);
    if (!exists) return;
    await appController.switchWorkspace(sourceId);
  }

  private startEdit(e: Event, id: string, field: 'name' | 'comment', currentValue: string) {
    e.stopPropagation();
    this.editing = { id, field };
    this.editValue = currentValue;
    this.updateComplete.then(() => {
      const selector = field === 'name' ? '.edit-input' : '.edit-textarea';
      const el = this.shadowRoot?.querySelector(selector) as HTMLElement;
      if (el) {
        el.focus();
        if (el instanceof HTMLInputElement) el.select();
        else if (el instanceof HTMLTextAreaElement) el.select();
      }
    });
  }

  private async commitEdit() {
    if (!this.editing) return;
    const { id, field } = this.editing;
    const value = this.editValue.trim();
    this.editing = null;

    if (field === 'name') {
      if (value) await appController.renameWorkspace(id, value);
    } else {
      appController.setWorkspaceComment(value);
    }
  }

  private cancelEdit() {
    this.editing = null;
  }

  private handleEditKeydown(e: KeyboardEvent) {
    if (this.editing?.field === 'name' && e.key === 'Enter') {
      e.preventDefault();
      this.commitEdit();
    } else if (this.editing?.field === 'comment' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.commitEdit();
    } else if (e.key === 'Escape') {
      this.cancelEdit();
    }
  }

  private async handleOpenExample(key: string) {
    if (this.busy) return;
    if (appState.local.draftExampleKey === key) return;
    await appController.openExample(key);
  }

  render() {
    // Sort reverse chronologically by updatedAt, then createdAt as tiebreaker
    const workspaces = [...appState.local.workspaces].sort((a, b) =>
      b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
    );
    const activeId = appController.activeWorkspaceId;
    const draftExampleKey = appState.local.draftExampleKey;

    return html`
      <div class="list">
        ${workspaces.map(ws => this.renderEntry(ws, activeId))}
      </div>
      <div class="examples-divider">
        <span>Examples</span>
      </div>
      <div class="examples-list">
        ${Object.entries(ALL_EXAMPLES).map(([key, example]) => html`
          <div
            class="example-entry ${draftExampleKey === key ? 'active' : ''}"
            @click=${() => this.handleOpenExample(key)}
          >
            <div class="example-name">${example.meta.name || key}</div>
            ${example.comment ? html`
              <div class="example-comment">${example.comment}</div>
            ` : nothing}
          </div>
        `)}
      </div>
    `;
  }

  private renderEntry(ws: WorkspaceIndexEntry, activeId: string) {
    const isActive = ws.id === activeId;
    const isConfirmingDelete = this.confirmingDeleteId === ws.id;
    const sourceExists = ws.forkedFrom
      ? appState.local.workspaces.some(w => w.id === ws.forkedFrom!.sourceId)
      : false;
    const comment = isActive ? appState.database.ir.comment : ws.comment;
    const isEditingName = this.editing?.id === ws.id && this.editing.field === 'name';
    const isEditingComment = this.editing?.id === ws.id && this.editing.field === 'comment';

    return html`
      <div
        class="workspace-entry ${isActive ? 'active' : ''}"
        @click=${() => this.handleSwitch(ws.id)}
      >
        <div class="workspace-info">
          ${isEditingName ? html`
            <input
              class="edit-input"
              .value=${this.editValue}
              @input=${(e: Event) => this.editValue = (e.target as HTMLInputElement).value}
              @blur=${() => this.commitEdit()}
              @keydown=${(e: KeyboardEvent) => this.handleEditKeydown(e)}
              @click=${(e: Event) => e.stopPropagation()}
            />
          ` : html`
            <div class="workspace-name" @dblclick=${(e: Event) => this.startEdit(e, ws.id, 'name', ws.name)}>${ws.name}</div>
          `}
          ${isEditingComment ? html`
            <textarea
              class="edit-textarea"
              .value=${this.editValue}
              @input=${(e: Event) => this.editValue = (e.target as HTMLTextAreaElement).value}
              @blur=${() => this.commitEdit()}
              @keydown=${(e: KeyboardEvent) => this.handleEditKeydown(e)}
              @click=${(e: Event) => e.stopPropagation()}
            ></textarea>
          ` : comment ? html`
            <div class="workspace-comment" @dblclick=${isActive ? (e: Event) => this.startEdit(e, ws.id, 'comment', comment) : null}>${comment}</div>
          ` : isActive ? html`
            <div class="comment-placeholder" @dblclick=${(e: Event) => this.startEdit(e, ws.id, 'comment', '')}>Add description...</div>
          ` : nothing}
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
