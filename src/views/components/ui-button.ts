import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
// @ts-ignore
import lineawesomecss from 'line-awesome/dist/line-awesome/css/line-awesome.css?raw';

@customElement('ui-button')
export class UiButton extends LitElement {
  @property({ type: String }) icon = '';
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) square = false; // Add square variant for icon-only buttons
  @property({ type: String }) variant = 'default'; // default | ghost | outline | danger

  @state() private hasContent = false;

  static readonly styles = [unsafeCSS(lineawesomecss), css`
    :host {
      display: inline-block;
      vertical-align: middle;
    }

    button {
      background-color: white;
      color: var(--color-stone-700);
      border: 1px solid var(--color-stone-200);
      border-radius: 0.375rem; /* 6px */
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.875rem;
      font-weight: 500;
      transition: all 0.15s ease-in-out;
      line-height: 1;
      height: 100%;
    }

    /* Square Icon Button */
    button.square {
      padding: 0.5rem;
      aspect-ratio: 1;
    }

    /* Variants */
    button.ghost {
      background-color: transparent;
      border-color: transparent;
      color: var(--color-stone-500);
    }
    button.ghost:hover {
      background-color: var(--color-stone-100);
      color: var(--color-stone-900);
    }

    button.outline {
       background-color: transparent;
       border: 1px solid var(--color-stone-300);
    }
    button.outline:hover {
       background-color: var(--color-stone-50);
       border-color: var(--color-stone-400);
    }

    /* Primary (Emerald) */
    button.primary {
       background-color: var(--color-emerald-600);
       border: 1px solid var(--color-emerald-600);
       color: white;
       box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.1);
    }
    button.primary:hover {
       background-color: var(--color-emerald-700);
       border-color: var(--color-emerald-700);
    }

    /* Default (Solid/White-ish) */
    button:not(.ghost):not(.outline):not(.primary) {
      box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    }
    button:not(.ghost):not(.outline):not(.primary):hover {
       background-color: var(--color-stone-50);
       border-color: var(--color-stone-300);
    }

    button:active:not(:disabled) {
       transform: translateY(1px);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }

    i {
      font-size: 1.25em; /* Scale icon relative to text */
    }

    span {
      margin-left: 0.5rem;
    }

    span.hidden {
        display: none;
    }
  `];

  private handleSlotChange(e: Event) {
    const slot = e.target as HTMLSlotElement;
    const nodes = slot.assignedNodes({ flatten: true });
    this.hasContent = nodes.some(node =>
      node.nodeType === Node.ELEMENT_NODE ||
      (node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== '')
    );
  }

  render() {
    return html`
      <button
        ?disabled=${this.disabled}
        class="${this.square ? 'square' : ''} ${this.variant}"
      >
        ${this.icon ? html`<i class="las ${this.icon}"></i>` : ''}
        <span class="${this.hasContent ? '' : 'hidden'}">
          <slot @slotchange=${this.handleSlotChange}></slot>
        </span>
      </button>
    `;
  }
}
