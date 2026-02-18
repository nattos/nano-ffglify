/**
 * RuntimeProxy - main-thread proxy wrapping postMessage to the runtime worker.
 * Replaces RuntimeManager for the app's runtime pipeline.
 */
import { observable, makeObservable, action, runInAction } from 'mobx';
import type { SerializedArtifacts } from '../workers/protocol';
import type { RuntimeWorkerResponse, RuntimeInputEntryMsg } from '../workers/protocol';
import type { RuntimeWorkerRequest } from '../workers/protocol';
import type { RuntimeValue } from '../webgpu/host-interface';

export type TransportState = 'playing' | 'paused' | 'stopped';

export type TextureSourceType = 'url' | 'file';

export interface TextureSource {
  type: TextureSourceType;
  value: string | File;
}

export enum RuntimeInputType {
  Texture = 'texture',
  Bool = 'bool',
  Int = 'int',
  Float = 'float',
  Float2 = 'float2',
  Float3 = 'float3',
  Float4 = 'float4',
}

export interface RuntimeInputEntry {
  id: string;
  type: RuntimeInputType;
  label: string;
  currentValue: any;
  defaultValue: any;
  min?: number;
  max?: number;
  displayText?: string;
}

interface InputSourceState {
  id: string;
  source: TextureSource;
  videoElement?: HTMLVideoElement;
  loadedBitmap?: ImageBitmap;
  isDirty: boolean;
  isLoading: boolean;
}

export class RuntimeProxy {
  @observable public transportState: TransportState = 'stopped';
  @observable public fps: number = 0;
  @observable public frameCount: number = 0;
  @observable public inputEntries: Map<string, RuntimeInputEntry> = new Map();

  // Store texture input IDs for drag-and-drop
  private textureInputIds: string[] = [];

  private worker: Worker;
  private frameId: number | null = null;
  private canvasTransferred = false;

  private inputSources: Map<string, InputSourceState> = new Map();

  private compiledResolve: ((ok: boolean) => void) | null = null;
  private screenshotResolve: ((data: { pixels: ArrayBuffer; width: number; height: number } | null) => void) | null = null;

  constructor() {
    makeObservable(this);
    this.worker = new Worker(
      new URL('../workers/runtime-worker.ts', import.meta.url),
      { type: 'module' }
    );
    this.worker.onmessage = (e: MessageEvent<RuntimeWorkerResponse>) => {
      this.handleMessage(e.data);
    };
  }

  async setCompiled(artifacts: SerializedArtifacts, savedFileInputIds?: Set<string>): Promise<boolean> {
    const msg: RuntimeWorkerRequest = {
      type: 'set-compiled',
      ir: artifacts.ir,
      finalInitCode: artifacts.finalInitCode,
      finalTaskCode: artifacts.finalTaskCode,
    };
    this.worker.postMessage(msg);

    return new Promise<boolean>((resolve) => {
      this.compiledResolve = resolve;
    });
  }

  attachCanvas(canvas: HTMLCanvasElement) {
    if (this.canvasTransferred) return;
    const offscreen = canvas.transferControlToOffscreen();
    const msg: RuntimeWorkerRequest = { type: 'set-canvas', canvas: offscreen };
    this.worker.postMessage(msg, [offscreen]);
    this.canvasTransferred = true;

    // Set initial size
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.resizeCanvas(rect.width, rect.height, dpr);
  }

  resizeCanvas(width: number, height: number, dpr: number) {
    const msg: RuntimeWorkerRequest = { type: 'resize-canvas', width, height, dpr };
    this.worker.postMessage(msg);
  }

  @action
  play() {
    if (this.transportState === 'playing') return;
    this.transportState = 'playing';
    this.worker.postMessage({ type: 'play' } as RuntimeWorkerRequest);
    this.startTickLoop();
  }

  @action
  pause() {
    this.transportState = 'paused';
    this.worker.postMessage({ type: 'pause' } as RuntimeWorkerRequest);
    this.stopTickLoop();
  }

  @action
  stop() {
    this.transportState = 'stopped';
    this.frameCount = 0;
    this.worker.postMessage({ type: 'stop' } as RuntimeWorkerRequest);
    this.stopTickLoop();
  }

  @action
  step() {
    this.pause();
    this.worker.postMessage({ type: 'step' } as RuntimeWorkerRequest);
  }

  setInput(id: string, value: RuntimeValue) {
    this.worker.postMessage({ type: 'set-input', id, value } as RuntimeWorkerRequest);
    // Update local inputEntries for immediate UI feedback
    runInAction(() => {
      const entry = this.inputEntries.get(id);
      if (entry) {
        entry.currentValue = value;
      }
    });
  }

  setTextureSource(id: string, source: TextureSource) {
    // Main thread loads media → creates ImageBitmap → transfers to worker
    let state = this.inputSources.get(id);
    if (!state) {
      state = { id, source, isDirty: true, isLoading: false };
      this.inputSources.set(id, state);
    } else {
      // Clean up previous
      if (state.videoElement) {
        state.videoElement.pause();
        state.videoElement.src = '';
        state.videoElement.load();
        state.videoElement = undefined;
      }
      if (state.loadedBitmap) {
        state.loadedBitmap.close();
        state.loadedBitmap = undefined;
      }
      state.source = source;
      state.isDirty = true;
    }

    this.loadSourceAndTransfer(state);

    // Update displayText in inputEntries
    runInAction(() => {
      const entry = this.inputEntries.get(id);
      if (entry) {
        entry.displayText = typeof source.value === 'string' ? source.value : source.value.name;
      }
    });
  }

  async resetTextureToTestCard(id: string) {
    // Clean up input source
    const source = this.inputSources.get(id);
    if (source) {
      if (source.videoElement) {
        source.videoElement.pause();
        source.videoElement.src = '';
        source.videoElement.load();
      }
      if (source.loadedBitmap) {
        source.loadedBitmap.close();
      }
      this.inputSources.delete(id);
    }

    this.worker.postMessage({ type: 'reset-texture-to-test-card', id } as RuntimeWorkerRequest);

    runInAction(() => {
      const entry = this.inputEntries.get(id);
      if (entry) {
        entry.displayText = undefined;
      }
    });
  }

  getTextureInputIds(): string[] {
    return this.textureInputIds;
  }

  async captureScreenshot(): Promise<{ pixels: ArrayBuffer; width: number; height: number } | null> {
    this.worker.postMessage({ type: 'capture-screenshot' } as RuntimeWorkerRequest);
    return new Promise((resolve) => {
      this.screenshotResolve = resolve;
    });
  }

  // --- Private ---

  private startTickLoop() {
    const tick = () => {
      if (this.transportState !== 'playing') return;
      this.worker.postMessage({ type: 'tick', time: performance.now() } as RuntimeWorkerRequest);
      this.frameId = requestAnimationFrame(tick);
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private stopTickLoop() {
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }

  @action
  private handleMessage(msg: RuntimeWorkerResponse) {
    switch (msg.type) {
      case 'ready':
        break;

      case 'compiled-ok':
        this.applyInputEntries(msg.inputEntries);
        if (this.compiledResolve) {
          this.compiledResolve(true);
          this.compiledResolve = null;
        }
        break;

      case 'compiled-error':
        console.error('Runtime worker compiled-error:', msg.message);
        if (this.compiledResolve) {
          this.compiledResolve(false);
          this.compiledResolve = null;
        }
        break;

      case 'frame':
        this.fps = msg.fps;
        this.frameCount = msg.frameCount;
        break;

      case 'error':
        console.error('Runtime worker error:', msg.message);
        break;

      case 'screenshot':
        if (this.screenshotResolve) {
          this.screenshotResolve({ pixels: msg.pixels, width: msg.width, height: msg.height });
          this.screenshotResolve = null;
        }
        break;
    }
  }

  @action
  private applyInputEntries(entries: RuntimeInputEntryMsg[]) {
    this.inputEntries.clear();
    this.textureInputIds = [];
    for (const e of entries) {
      const entry: RuntimeInputEntry = {
        id: e.id,
        type: e.type as RuntimeInputType,
        label: e.label,
        currentValue: e.currentValue,
        defaultValue: e.defaultValue,
        min: e.min,
        max: e.max,
        displayText: e.displayText,
      };
      this.inputEntries.set(e.id, entry);
      if (e.type === 'texture') {
        this.textureInputIds.push(e.id);
      }
    }
  }

  private async loadSourceAndTransfer(state: InputSourceState) {
    state.isLoading = true;
    try {
      let bitmap: ImageBitmap | null = null;

      if (state.source.type === 'url') {
        const url = state.source.value as string;
        if (url.match(/\.(mp4|webm|ogg|mov)$/i)) {
          // Video: create element, capture frame as bitmap
          const video = this.createVideoElement(url);
          state.videoElement = video;
          // Wait for video to be ready, then start per-frame capture
          await new Promise<void>((resolve) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => resolve();
          });
          if (video.readyState >= 2) {
            bitmap = await createImageBitmap(video);
          }
        } else {
          const response = await fetch(url);
          const blob = await response.blob();
          bitmap = await createImageBitmap(blob);
        }
      } else {
        const file = state.source.value as File;
        if (file.type.startsWith('video/')) {
          const url = URL.createObjectURL(file);
          const video = this.createVideoElement(url);
          state.videoElement = video;
          await new Promise<void>((resolve) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => resolve();
          });
          if (video.readyState >= 2) {
            bitmap = await createImageBitmap(video);
          }
        } else {
          bitmap = await createImageBitmap(file);
        }
      }

      if (bitmap) {
        state.loadedBitmap = bitmap;
        this.transferBitmap(state.id, bitmap);
        state.isDirty = false;
      }
    } catch (e) {
      console.error(`Failed to load source for ${state.id}:`, e);
    } finally {
      state.isLoading = false;
    }
  }

  private transferBitmap(id: string, bitmap: ImageBitmap) {
    const msg: RuntimeWorkerRequest = { type: 'set-texture-input', id, bitmap };
    this.worker.postMessage(msg, [bitmap]);
  }

  private createVideoElement(url: string): HTMLVideoElement {
    const video = document.createElement('video');
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.play();
    return video;
  }

  public dispose() {
    this.stopTickLoop();
    // Clean up video elements
    for (const state of this.inputSources.values()) {
      if (state.videoElement) {
        state.videoElement.pause();
        state.videoElement.src = '';
        state.videoElement.load();
      }
      if (state.loadedBitmap) {
        state.loadedBitmap.close();
      }
    }
    this.inputSources.clear();
    this.worker.terminate();
  }
}
