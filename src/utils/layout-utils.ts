import { action } from "mobx";

export type Point = [x: number, y: number];

export function lerp(a: number, b: number, t: number) {
  return a * (1.0 - t) + b * t;
}

export function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export function easeOut(x: number) {
  return Math.sqrt(x);
}

export function wrapInt(x: number, m: number) {
  if (x < 0) {
    return ((m - x) % m) | 0;
  }
  return (x % m) | 0;
}

export function wrapFloat01(x: number) {
  return x - Math.floor(x);
}

export function wrapClick<T extends Event>(callback: (e: T) => unknown) {
  return action((e: T) => {
    e.stopPropagation();
    e.preventDefault();
    callback(e);
  });
}


export interface ColorFromHash {
  lcenter?: number;
  lrange?: number;
  scenter?: number;
  srange?: number;
}

export const DEFAULT_COLOR_FROM_HASH = {
  lcenter: 0.4,
  lrange: 0.1,
  scenter: 0.8,
  srange: 0.1,
} satisfies ColorFromHash;

export function cssColorFromHash(text: string, config?: ColorFromHash) {
  const lcenter = config?.lcenter ?? DEFAULT_COLOR_FROM_HASH.lcenter;
  const lrange = config?.lrange ?? DEFAULT_COLOR_FROM_HASH.lrange;
  const scenter = config?.lrange ?? DEFAULT_COLOR_FROM_HASH.scenter;
  const srange = config?.lrange ?? DEFAULT_COLOR_FROM_HASH.srange;
  const hash = (simpleHash(text) * 22695477 + 1) | 0;
  const ph = (((hash >> 0) & 0xFF) | 0) / 0xFF;
  const ps = (((hash >> 8) & 0xFF) | 0) / 0xFF;
  const pl = (((hash >> 16) & 0xFF) | 0) / 0xFF;

  // Perceptual adjustments.
  const yellowH = (1 / 6);
  const yellowAmount = clamp01(1.0 - Math.abs((ph - yellowH)) * 4.0);
  const blueH = (2 / 3);
  const blueAmount = clamp01(1.0 - Math.abs((ph - blueH)) * 8.0);

  let h = ph;
  let s = clamp01(lerp(scenter - srange, scenter + srange, ps));
  let l = clamp01(lerp(lcenter - lrange, lcenter + lrange, pl));
  l = lerp(l, l * l, yellowAmount * 0.25);
  l = lerp(l, Math.sqrt(l), blueAmount * 0.25);
  s = lerp(s, Math.sqrt(s), yellowAmount);
  return `hsl(${(h * 360).toFixed(0)} ${(s * 100).toFixed(0)} ${(l * 100).toFixed(0)})`;
}

function simpleHash(str: string) {
  let hash = 0;
  for (let i = 0, len = str.length; i < len; i++) {
    let chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return hash;
}
