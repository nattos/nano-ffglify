import './ui-icon';
import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { RuntimeManager, RuntimeInputEntry, RuntimeInputType } from '../../runtime/runtime-manager';
import { appController } from '../../state/controller';

@customElement('ui-inspector')
export class UiInspector extends MobxLitElement {
  @property({ type: Object }) runtime: RuntimeManager | null = null;
  @state() private draggingId: string | null = null;

  static readonly styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow-y: auto;
      color: #ccc;
      font-family: var(--font-sans, sans-serif);
      font-size: 0.85rem;
    }

    .input-list {
      display: flex;
      flex-direction: column;
      padding: 0.5rem;
      gap: 1rem;
    }

    .input-item {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    .label-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .label {
      color: #aaa;
      font-weight: 500;
    }

    .value-display {
      color: var(--color-emerald-500, #10b981);
      font-family: monospace;
      font-size: 0.7rem;
      background: rgba(16, 185, 129, 0.1);
      padding: 0.1rem 0.3rem;
      border-radius: 2px;
    }

    /* Range/Slider Styles */
    input[type="range"] {
      width: 100%;
      height: 24px; /* Expanded hit area */
      background: transparent; /* Remove default background */
      appearance: none;
      outline: none;
      margin: 0;
      cursor: pointer;
    }

    input[type="range"]::-webkit-slider-runnable-track {
        background: linear-gradient(to right, var(--color-emerald-600) var(--percent, 0%), #333 var(--percent, 0%));
        height: 4px;
        border-radius: 2px;
    }

    input[type="range"]::-webkit-slider-thumb {
      appearance: none;
      width: 12px;
      height: 12px;
      background: var(--color-emerald-500, #10b981);
      border-radius: 50%;
      cursor: pointer;
      margin-top: -4px; /* Center thumb on track (track is 4px, thumb is 12px) */
      transition: transform 0.1s ease, box-shadow 0.2s;
      border: none;
    }

    input[type="range"]::-webkit-slider-thumb:hover {
      transform: scale(1.2);
      box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.1);
    }

    /* Texture Slot Styles */
    .texture-slot {
      border: 1px dashed #444;
      border-radius: 4px;
      padding: 0.6rem;
      background: #222;
      cursor: pointer;
      transition: all 0.2s ease;
      font-size: 0.75rem;
      color: #666;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      position: relative;
    }

    .texture-slot.dragging {
      border-color: var(--color-emerald-500, #10b981);
      background: rgba(16, 185, 129, 0.1);
      color: #eee;
    }

    .texture-slot:hover {
      border-color: #666;
      background: #2a2a2a;
    }

    .texture-slot.filled {
        color: #ddd;
        border-style: solid;
    }

    /* Boolean Toggle Styles */
    .toggle {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
      user-select: none;
    }

    .toggle-track {
      width: 32px;
      height: 18px;
      background: #333;
      border-radius: 9px;
      position: relative;
      transition: background 0.2s ease;
    }

    .toggle.active .toggle-track {
      background: var(--color-emerald-600, #059669);
    }

    .toggle-thumb {
      width: 14px;
      height: 14px;
      background: #fff;
      border-radius: 50%;
      position: absolute;
      top: 2px;
      left: 2px;
      transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .toggle.active .toggle-thumb {
      transform: translateX(14px);
    }

    /* Vector/Color Row */
    .vector-row {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 0.25rem;
    }

    .vector-row input {
        background: #222;
        border: 1px solid #333;
        color: var(--color-emerald-500, #10b981);
        font-family: monospace;
        font-size: 0.7rem;
        padding: 0.25rem;
        border-radius: 2px;
        width: 100%;
        box-sizing: border-box;
        text-align: center;
    }
    .vector-row input:focus {
        border-color: var(--color-emerald-500);
        outline: none;
        background: #2a2a2a;
    }

    /* Reset button styles */
    .reset-all-row {
      display: flex;
      justify-content: flex-end;
      padding: 0.5rem 0.5rem 0;
    }

    .reset-all-btn {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      border: none;
      background: none;
      color: var(--app-text-muted, #888);
      cursor: pointer;
      font-size: 0.7rem;
      font-family: inherit;
      padding: 0.2rem 0.4rem;
      border-radius: 3px;
    }

    .reset-all-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--app-text-main, #ccc);
    }

    .reset-all-btn.disabled {
      color: var(--app-text-muted, #888);
      opacity: 0.3;
      cursor: default;
      pointer-events: none;
    }

    .reset-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border: none;
      background: none;
      color: var(--app-text-muted, #888);
      cursor: pointer;
      border-radius: 3px;
      padding: 0;
      flex-shrink: 0;
    }

    .reset-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--app-text-main, #ccc);
    }

    .reset-btn.disabled {
      opacity: 0.3;
      cursor: default;
      pointer-events: none;
    }
  `;

  render() {
    if (!this.runtime) return html`<div style="padding: 0.5rem; color: var(--app-text-muted, #888); font-size: 0.8rem;">No runtime active</div>`;

    const entries = Array.from(this.runtime.inputEntries.values());

    if (entries.length === 0) {
      return html`<div style="padding: 1rem; color: var(--app-text-muted, #888); font-size: 0.85rem; text-align: center;">${'\u2661'} No parameters yet</div>`;
    }

    const anyModified = entries.some(e =>
      e.type === RuntimeInputType.Texture ? !!e.displayText : !this.isDefault(e)
    );

    return html`
      <div class="reset-all-row">
        <button class="reset-all-btn ${anyModified ? '' : 'disabled'}" @click=${() => this.handleResetAll(entries)} title="Reset all parameters to defaults">
          <ui-icon icon="la-undo" style="--icon-size: 0.7rem;"></ui-icon>
          Reset all
        </button>
      </div>
      <div class="input-list">
        ${entries.map(entry => this.renderInput(entry))}
      </div>
    `;
  }

  private renderInput(entry: RuntimeInputEntry) {
    switch (entry.type) {
      case RuntimeInputType.Float:
      case RuntimeInputType.Int:
        return this.renderNumber(entry);
      case RuntimeInputType.Bool:
        return this.renderBool(entry);
      case RuntimeInputType.Texture:
        return this.renderTexture(entry);
      case RuntimeInputType.Float4:
        return this.renderVector(entry, 4);
      default:
        return html`
          <div class="input-item">
            <div class="label">${entry.label}</div>
            <div style="color:red; font-size: 10px;">Unsupported ${entry.type}</div>
          </div>
        `;
    }
  }

  private renderNumber(entry: RuntimeInputEntry) {
    const isInt = entry.type === RuntimeInputType.Int;
    const value = entry.currentValue ?? 0;
    const min = entry.min ?? 0;
    const max = entry.max ?? 100;
    const percent = ((value - min) / (max - min)) * 100;

    const modified = !this.isDefault(entry);

    return html`
      <div class="input-item">
        <div class="label-row">
          <span class="label">${entry.label}</span>
          <span style="display:flex;align-items:center;gap:0.25rem;">
            <span class="value-display">${isInt ? value : value.toFixed(3)}</span>
            <button class="reset-btn ${modified ? '' : 'disabled'}" @click=${() => this.handleReset(entry)} title="Reset to default">
              <ui-icon icon="la-undo" style="--icon-size: 0.7rem;"></ui-icon>
            </button>
          </span>
        </div>
        <input
          type="range"
          .min=${min}
          .max=${max}
          .step=${isInt ? 1 : 0.001}
          .value=${value}
          style="--percent: ${percent}%"
          @input=${(e: any) => this.handleUpdate(entry.id, isInt ? parseInt(e.target.value) : parseFloat(e.target.value))}
        />
      </div>
    `;
  }

  private renderBool(entry: RuntimeInputEntry) {
    const active = !!entry.currentValue;
    const modified = !this.isDefault(entry);
    return html`
      <div class="input-item">
        <div class="label-row">
          <span class="label">${entry.label}</span>
          <button class="reset-btn ${modified ? '' : 'disabled'}" @click=${() => this.handleReset(entry)} title="Reset to default">
            <ui-icon icon="la-undo" style="--icon-size: 0.7rem;"></ui-icon>
          </button>
        </div>
        <div class="toggle ${active ? 'active' : ''}" @click=${() => this.handleUpdate(entry.id, !active)}>
          <div class="toggle-track">
            <div class="toggle-thumb"></div>
          </div>
          <span>${active ? 'On' : 'Off'}</span>
        </div>
      </div>
    `;
  }

  private renderTexture(entry: RuntimeInputEntry) {
    const isFilled = !!entry.displayText;
    const isDragging = this.draggingId === entry.id;

    return html`
      <div class="input-item">
        <div class="label-row">
          <span class="label">${entry.label}</span>
          <button class="reset-btn ${isFilled ? '' : 'disabled'}" @click=${() => this.handleResetTexture(entry)} title="Clear texture">
            <ui-icon icon="la-undo" style="--icon-size: 0.7rem;"></ui-icon>
          </button>
        </div>
        <div
          class="texture-slot ${isFilled ? 'filled' : ''} ${isDragging ? 'dragging' : ''}"
          @dragover=${(e: DragEvent) => this.handleDragOver(e, entry.id)}
          @dragleave=${() => this.draggingId = null}
          @drop=${(e: DragEvent) => this.handleDrop(e, entry.id)}
        >
          ${entry.displayText || 'Drag & drop image/video...'}
        </div>
      </div>
    `;
  }

  private renderVector(entry: RuntimeInputEntry, size: number) {
    const vals = Array.isArray(entry.currentValue) ? entry.currentValue : [0, 0, 0, 0];
    const modified = !this.isDefault(entry);
    return html`
        <div class="input-item">
            <div class="label-row">
              <span class="label">${entry.label}</span>
              <button class="reset-btn ${modified ? '' : 'disabled'}" @click=${() => this.handleReset(entry)} title="Reset to default">
                <ui-icon icon="la-undo" style="--icon-size: 0.7rem;"></ui-icon>
              </button>
            </div>
            <div class="vector-row">
                ${[...Array(size)].map((_, i) => html`
                    <input
                        type="number"
                        .value=${vals[i] ?? 0}
                        @input=${(e: any) => {
        const newVals = [...vals];
        newVals[i] = parseFloat(e.target.value);
        this.handleUpdate(entry.id, newVals);
      }}
                    />
                `)}
            </div>
        </div>
    `;
  }

  private isDefault(entry: RuntimeInputEntry): boolean {
    const cur = entry.currentValue;
    const def = entry.defaultValue;
    if (Array.isArray(cur) && Array.isArray(def)) {
      return cur.length === def.length && cur.every((v, i) => v === def[i]);
    }
    return cur === def;
  }

  private handleReset(entry: RuntimeInputEntry) {
    this.handleUpdate(entry.id, entry.defaultValue);
  }

  private handleResetTexture(entry: RuntimeInputEntry) {
    if (!this.runtime) return;
    this.runtime.setTextureSource(entry.id, { type: 'url', value: 'test.png' });
    appController.saveInputValue(entry.id, undefined);
  }

  private handleResetAll(entries: RuntimeInputEntry[]) {
    for (const entry of entries) {
      if (entry.type === RuntimeInputType.Texture) {
        if (entry.displayText) this.handleResetTexture(entry);
      } else if (!this.isDefault(entry)) {
        this.handleUpdate(entry.id, entry.defaultValue);
      }
    }
  }

  private handleUpdate(id: string, value: any) {
    if (this.runtime) {
      this.runtime.setInput(id, value);
      appController.saveInputValue(id, value);
    }
  }

  private handleDragOver(e: DragEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    this.draggingId = id;
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  private handleDrop(e: DragEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    this.draggingId = null;
    const file = e.dataTransfer?.files[0];
    if (file && this.runtime) {
      this.runtime.setTextureSource(id, { type: 'file', value: file });
      appController.saveInputFile(id, file);
    }
  }
}
