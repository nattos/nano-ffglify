/**
 * Message type definitions shared by compilation and runtime workers.
 */
import type { IRDocument } from '../ir/types';
import type { LogicValidationError } from '../ir/validator';
import type { RuntimeValue } from '../webgpu/host-interface';

// ---------------------------------------------------------------------------
// Serialized compilation artifacts (functions replaced by code strings)
// ---------------------------------------------------------------------------
export interface SerializedArtifacts {
  ir: IRDocument;
  finalInitCode: string;
  finalTaskCode: string;
  initCode: string;   // raw (for display in code view)
  taskCode: string;    // raw (for display)
  wgsl: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Main → Compilation Worker
// ---------------------------------------------------------------------------
export interface CompileRequest {
  type: 'compile';
  id: number;
  ir: IRDocument;
}

export type CompilationWorkerRequest = CompileRequest;

// ---------------------------------------------------------------------------
// Compilation Worker → Main
// ---------------------------------------------------------------------------
export interface CompileSuccess {
  type: 'compiled';
  id: number;
  artifacts: SerializedArtifacts;
}

export interface CompileError {
  type: 'compile-error';
  id: number;
  errors: LogicValidationError[];
  message: string;
}

export type CompilationWorkerResponse = CompileSuccess | CompileError;

// ---------------------------------------------------------------------------
// Main → Runtime Worker
// ---------------------------------------------------------------------------
export interface SetCompiledMsg {
  type: 'set-compiled';
  ir: IRDocument;
  finalInitCode: string;
  finalTaskCode: string;
}

export interface SetCanvasMsg {
  type: 'set-canvas';
  canvas: OffscreenCanvas;
}

export interface ResizeCanvasMsg {
  type: 'resize-canvas';
  width: number;
  height: number;
  dpr: number;
}

export interface PlayMsg { type: 'play' }
export interface PauseMsg { type: 'pause' }
export interface StepMsg { type: 'step' }
export interface TickMsg { type: 'tick'; time: number }
export interface StopMsg { type: 'stop' }

export interface SetInputMsg {
  type: 'set-input';
  id: string;
  value: RuntimeValue;
}

export interface SetTextureInputMsg {
  type: 'set-texture-input';
  id: string;
  bitmap: ImageBitmap;
}

export interface ResetTextureMsg {
  type: 'reset-texture-to-test-card';
  id: string;
}

export interface CaptureScreenshotMsg {
  type: 'capture-screenshot';
}

export type RuntimeWorkerRequest =
  | SetCompiledMsg
  | SetCanvasMsg
  | ResizeCanvasMsg
  | PlayMsg
  | PauseMsg
  | StepMsg
  | StopMsg
  | TickMsg
  | SetInputMsg
  | SetTextureInputMsg
  | ResetTextureMsg
  | CaptureScreenshotMsg;

// ---------------------------------------------------------------------------
// Runtime Worker → Main
// ---------------------------------------------------------------------------

export interface RuntimeInputEntryMsg {
  id: string;
  type: string; // RuntimeInputType value
  label: string;
  currentValue: any;
  defaultValue: any;
  min?: number;
  max?: number;
  displayText?: string;
}

export interface ReadyMsg { type: 'ready' }

export interface CompiledOkMsg {
  type: 'compiled-ok';
  inputEntries: RuntimeInputEntryMsg[];
}

export interface CompiledErrorMsg {
  type: 'compiled-error';
  message: string;
}

export interface FrameMsg {
  type: 'frame';
  frameCount: number;
  fps: number;
}

export interface RuntimeErrorMsg {
  type: 'error';
  message: string;
}

export interface ScreenshotMsg {
  type: 'screenshot';
  pixels: ArrayBuffer;
  width: number;
  height: number;
}

export type RuntimeWorkerResponse =
  | ReadyMsg
  | CompiledOkMsg
  | CompiledErrorMsg
  | FrameMsg
  | RuntimeErrorMsg
  | ScreenshotMsg;
