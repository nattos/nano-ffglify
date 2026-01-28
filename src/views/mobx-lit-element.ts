import { LitElement, PropertyValues, TemplateResult } from 'lit';
import { autorun, IReactionDisposer } from 'mobx';

export class MobxLitElement extends LitElement {
  private disposer: IReactionDisposer | null = null;
  private cachedTemplate: TemplateResult | null = null;
  private originalRender: (() => unknown) | null = null;

  connectedCallback() {
    super.connectedCallback();

    // Capture the original render method from the instance (or prototype)
    // We bind it to 'this' so it executes correctly.
    this.originalRender = this.render.bind(this);

    // This single render override handles all cases.
    this.render = () => {
      // Case 1: A template was cached by a mobx reaction. Consume it.
      if (this.cachedTemplate) {
        const template = this.cachedTemplate;
        this.cachedTemplate = null; // Dequeue the template
        return template;
      }

      // Case 2: Lit is driving the render (initial render or lit property change).
      // We need to synchronously return a template, and also set up a new mobx reaction
      // to handle future mobx-driven changes.
      // Dispose the old reaction, as we are creating a new one with a new dependency tree.
      if (this.disposer) {
        this.disposer();
      }

      let template: TemplateResult | null = null;
      let isInitialSyncRun = true;

      this.disposer = autorun(() => {
        if (!this.originalRender) return;

        try {
          const result = this.originalRender() as TemplateResult;
          if (isInitialSyncRun) {
            // On the first, synchronous run, just produce the template to be returned by render().
            template = result;
          } else {
            // On subsequent, mobx-triggered runs, cache the template and request an update from Lit.
            this.cachedTemplate = result;
            this.requestUpdate();
          }
        } catch (e) {
          console.error("Error in MobxLitElement render:", e);
        }
      });

      isInitialSyncRun = false; // The synchronous run is complete.
      return template;
    };
  }

  protected update(changedProperties: PropertyValues): void {
    super.update(changedProperties);
    if (changedProperties.size > 0) {
      this.requestUpdate();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.disposer) {
      this.disposer();
      this.disposer = null;
    }
    // Restore original render? Not strictly necessary since the instance is disconnecting,
    // but good practice if it reconnects.
    // Actually, if it reconnects, connectedCallback runs again.
    // We should probably restore it to avoid double-wrapping if connectedCallback runs twice.
    if (this.originalRender) {
      this.render = this.originalRender;
      this.originalRender = null;
    }
  }
}
