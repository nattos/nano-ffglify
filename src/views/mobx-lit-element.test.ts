import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { observable, makeObservable, action } from 'mobx';
import { MobxLitElement } from './mobx-lit-element';

class Store {
  @observable value = 'initial';

  constructor() {
    makeObservable(this);
  }

  @action
  setValue(newValue: string) {
    this.value = newValue;
  }
}

@customElement('test-mobx-element-2')
class TestElement extends MobxLitElement {
  store: Store;

  constructor(store: Store) {
    super();
    this.store = store;
  }

  render() {
    return html`<div>${this.store.value}</div>`;
  }
}

describe('MobxLitElement', () => {
  let store: Store;
  let element: TestElement;
  const container = document.createElement('div');
  document.body.appendChild(container);

  beforeEach(() => {
    store = new Store();
    element = new TestElement(store);
  });

  afterEach(() => {
    container.innerHTML = '';
  });

  it('should render initial state', async () => {
    container.appendChild(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toBe('initial');
  });

  it('should re-render when mobx state changes', async () => {
    container.appendChild(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toBe('initial');

    const requestUpdateSpy = vi.spyOn(element, 'requestUpdate');

    store.setValue('updated');

    // Give time for autorun to trigger requestUpdate
    await new Promise(resolve => setTimeout(resolve, 0));

    // The reaction should have triggered an update
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toBe('updated');
  });

  it('should clean up disposer on disconnect', async () => {
    container.appendChild(element);
    await element.updateComplete;

    // @ts-expect-error private property
    const disposer = element.disposer;
    expect(disposer).not.toBeNull();

    element.remove();

    // @ts-expect-error private property
    expect(element.disposer).toBeNull();
  });

  it('should not reuse cached template on subsequent non-mobx renders', async () => {
    container.appendChild(element);
    await element.updateComplete;

    // @ts-expect-error private property
    const originalRenderSpy = vi.spyOn(element, 'originalRender');

    // Trigger a new render without a mobx change.
    element.requestUpdate();
    await element.updateComplete;

    // The new implementation should re-evaluate the template, calling originalRender.
    expect(originalRenderSpy).toHaveBeenCalled();
  });
});

@customElement('mixed-props-element')
class MixedPropsElement extends MobxLitElement {
  store: {
    a: string;
    b: string;
  };

  @property({ type: Boolean })
  useB = false;

  constructor(store: any) {
    super();
    this.store = store;
  }

  render() {
    return html`<div>${this.useB ? this.store.b : this.store.a}</div>`;
  }
}

describe('MobxLitElement with mixed properties', () => {
  let store: { a: string, b: string, setValue: (key: 'a' | 'b', val: string) => void};
  let element: MixedPropsElement;
  const container = document.createElement('div');
  document.body.appendChild(container);

  beforeEach(() => {
    const s = observable({
      a: 'A',
      b: 'B',
    });
    // Create the action and assign it to the observable object.
    const store_with_action = Object.assign(s, {
        setValue: action((key: 'a' | 'b', val: string) => {
            s[key] = val;
        })
    });
    store = store_with_action;
    element = new MixedPropsElement(store);
  });

  afterEach(() => {
    container.innerHTML = '';
  });

  it('should rerender correctly when lit properties change and update mobx dependencies', async () => {
    // Initial render, depends on store.a
    container.appendChild(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toBe('A');

    // Change a mobx property it depends on
    store.setValue('a', 'A-updated');
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toBe('A-updated');

    // Now, change a lit property, which will cause a lit-driven render
    // This will switch the dependency from store.a to store.b
    element.useB = true;
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toBe('B');

    // *** The important part ***
    // Now that the dependency tree should have changed, changing the OLD
    // dependency should do nothing.
    const requestUpdateSpy = vi.spyOn(element, 'requestUpdate');
    store.setValue('a', 'A-final');
    await new Promise(resolve => setTimeout(resolve, 0)); // wait for reaction
    expect(requestUpdateSpy).not.toHaveBeenCalled();
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toBe('B'); // Unchanged

    // But changing the NEW dependency should trigger a render.
    store.setValue('b', 'B-updated');
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toBe('B-updated');
  });
});
