import 'line-awesome/dist/line-awesome/css/line-awesome.css';
// @ts-ignore
import lineawesomecss from 'line-awesome/dist/line-awesome/css/line-awesome.css?raw';
import { css, unsafeCSS } from 'lit';

export const globalStyles = [
  unsafeCSS(lineawesomecss),
  css`
  :host {
    --pixel: 1px;
  }
  @media (min-resolution: 2dppx) {
    :host {
      --pixel: 0.5px;
    }
  }

  :host {
    /* Brunch & Bloom Theme Palette */
    --color-emerald-50: #ecfdf5;
    --color-emerald-100: #d1fae5;
    --color-emerald-500: #10b981;
    --color-emerald-600: #059669;
    --color-emerald-700: #047857;

    --color-stone-50: #fafaf9;
    --color-stone-100: #f5f5f4;
    --color-stone-200: #e7e5e4;
    --color-stone-300: #d6d3d1;
    --color-stone-400: #a8a29e;
    --color-stone-500: #78716c;
    --color-stone-600: #57534e;
    --color-stone-800: #292524;
    --color-stone-900: #1c1917;

    --color-rose-50: #fff1f2;
    --color-rose-100: #ffe4e6;
    --color-rose-400: #fb7185;
    --color-rose-500: #f43f5e;
    --color-rose-600: #e11d48;
    --color-rose-700: #be123c;

    --color-amber-500: #f59e0b;
    --color-sky-100: #e0f2fe;
    --color-sky-600: #0284c7;

    --app-bg: #121212; /* Deep dark background */
    --app-header-bg: #1e1e1e;
    --app-text-main: #e0e0e0;
    --app-text-muted: #888888;
    --app-border: #333333;

    --font-serif: "Merriweather", "Georgia", serif;
    --font-sans: "Inter", "Helvetica Neue", sans-serif;

    /* Legacy mapping */
    --app-color1: var(--app-bg);
    --app-text-color1: var(--app-text-main);
  }

  body {
    background-color: var(--app-bg);
    color: var(--app-text-main);
    font-family: var(--font-sans);
  }

  /* Utility classes */
  .font-serif { font-family: var(--font-serif); }
  .font-bold { font-weight: 700; }
  .text-xs { font-size: 0.75rem; }
  .text-sm { font-size: 0.875rem; }
  .uppercase { text-transform: uppercase; }
  .tracking-wider { letter-spacing: 0.05em; }
  .rounded-full { border-radius: 9999px; }
  .rounded-2xl { border-radius: 1rem; }
  .rounded-3xl { border-radius: 1.5rem; }
  .shadow-sm { box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
`];

export const widgetStyles = css`
  :host {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--node-bg, #222);
    border: 1px solid var(--node-border, #444);
    border-radius: 4px;
    overflow: hidden;
    position: relative;
    user-select: none;
  }

  svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  path {
    vector-effect: non-scaling-stroke;
  }

  .grid-pattern, .grid {
    stroke: var(--grid-color, rgba(255, 255, 255, 0.05));
    stroke-width: 1;
  }

  .axis-line, .zero-line {
    stroke: var(--border-color, rgba(255, 255, 255, 0.3));
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
`;

export const animations = css`
  @keyframes flash-activation {
    0% {
        background-color: var(--button-bg);
        border-color: var(--app-hi-color1);
        box-shadow: 0 0 5px var(--selection-color);
    }
    100% {
        border-color: var(--border-color);
        box-shadow: none;
    }
  }

  .flashing {
    animation: flash-activation 0.2s ease-out forwards;
  }
`;
