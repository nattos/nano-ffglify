import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { IRDocument, FunctionDef } from '../../ir/types';
import { analyzeFunction, analyzeGlobals, AnalyzedFunction, IRLine, IRLinePart } from '../../ir/analyzer';
import { globalStyles } from '../../styles';

@customElement('ui-ir-widget')
export class UiIrWidget extends LitElement {
  @property({ type: Object }) ir: IRDocument | null = null;
  @state() private analyzedFunctions: AnalyzedFunction[] = [];
  @state() private globalLines: IRLine[] = [];
  @state() private hoveredRefId: string | null = null;

  static readonly styles = [
    ...globalStyles,
    css`
      :host {
        display: block;
        background: #1e1e1e;
        color: #d4d4d4;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        padding: 1rem;
        border-radius: 8px;
        overflow: auto;
        line-height: 1.5;
        font-size: 14px;
        box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);
      }

      .line {
        white-space: pre;
        min-height: 1.5em;
        padding: 0 0.5rem;
        border-radius: 4px;
        transition: background-color 0.05s;
      }

      .line:hover {
        background-color: rgba(255, 255, 255, 0.05);
      }

      .part {
        display: inline-block;
      }

      .part-op { color: #569cd6; font-weight: bold; }
      .part-ref {
        color: #9cdcfe;
        cursor: pointer;
        padding: 0 2px;
        border-radius: 3px;
        transition: all 0.05s;
      }
      .part-ref:hover {
        background-color: rgba(156, 220, 254, 0.2);
        text-decoration: underline;
      }
      .part-ref.highlighted {
        background-color: rgba(156, 220, 254, 0.4);
        box-shadow: 0 0 4px rgba(156, 220, 254, 0.6);
      }

      .part-literal { color: #ce9178; }
      .part-keyword { color: #c586c0; }
      .part-separator { color: #808080; }
      .part-type { color: #4ec9b0; font-style: italic; }
      .part-comment { color: #6a9955; }

      .indent-0 { margin-left: 0; }
      .indent-1 { margin-left: 1.5rem; }
      .indent-2 { margin-left: 3rem; }
      .indent-3 { margin-left: 4.5rem; }
      .indent-4 { margin-left: 6rem; }

      .function-block {
        margin-bottom: 2rem;
        border-left: 2px solid rgba(255, 255, 255, 0.1);
        padding-left: 0.5rem;
      }

      .globals-block {
        margin-bottom: 1.5rem;
        padding: 0.5rem;
        background: rgba(255, 255, 255, 0.02);
        border-radius: 4px;
        border-left: 2px solid rgba(156, 220, 254, 0.2);
      }

      .header {
        font-size: 0.9rem;
        color: #888;
        margin-bottom: 1rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        padding-bottom: 0.5rem;
      }
    `
  ];

  updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('ir') && this.ir) {
      this.analyzedFunctions = this.ir.functions.map(f => analyzeFunction(f, this.ir!));
      this.globalLines = analyzeGlobals(this.ir);
    }
  }

  private handleRefMouseOver(refId: string) {
    this.hoveredRefId = refId;
  }

  private handleRefMouseOut() {
    this.hoveredRefId = null;
  }

  render() {
    if (!this.ir) return html`<div>No IR loaded.</div>`;

    return html`
      <div class="globals-block">
        ${this.globalLines.map(line => this.renderLine(line))}
      </div>
      ${this.analyzedFunctions.map(func => html`
        <div class="function-block">
          ${func.lines.map(line => this.renderLine(line))}
        </div>
      `)}
    `;
  }

  private renderLine(line: IRLine) {
    // Note: Explicitly keep newlines tidy for copy paste.
    return html`<div class="line indent-${line.indent}">${line.parts.map(part => this.renderPart(part))}</div>`;
  }

  private renderPart(part: IRLinePart) {
    const isHighlighted = part.refId && this.hoveredRefId === part.refId;

    if (part.type === 'ref' && part.refId) {
      // Note: Explicitly keep newlines tidy for copy paste.
      return html`<span
          class="part part-ref ${isHighlighted ? 'highlighted' : ''}"
          @mouseover=${() => this.handleRefMouseOver(part.refId!)}
          @mouseout=${() => this.handleRefMouseOut()}
        >${part.text}</span>`;
    }

    return html`<span class="part part-${part.type}">${part.text}</span>`;
  }
}
