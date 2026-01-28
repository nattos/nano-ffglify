import { describe, it, expect, vi } from 'vitest';
import { html, render } from 'lit';

// Mock appState to prevent IDB init
vi.mock('../src/state/state', () => ({
  appState: {
    database: { notes: {}, chat_history: [] },
    local: { selectedEntity: null }
  }
}));

import '../src/views/components/ui-icon';
import '../src/views/components/ui-button';

describe('UI Components', () => {
  it('should render ui-icon', () => {
    const el = document.createElement('ui-icon');
    el.setAttribute('icon', 'la-test');
    document.body.appendChild(el);
    expect(el).toBeDefined();
  });

  it('should render ui-button', async () => {
    const el = document.createElement('ui-button');
    el.innerText = "Click Me";
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el).toBeDefined();
    expect(el.innerText).toBe("Click Me");
  });
});
