/**
 * CompilationProxy - main-thread proxy wrapping postMessage to the compilation worker.
 * Replaces ReplManager for the app's compilation pipeline.
 */
import { observable, makeObservable, action, toJS } from 'mobx';
import type { IRDocument } from '../ir/types';
import type { LogicValidationError } from '../ir/validator';
import type { SerializedArtifacts, CompilationWorkerResponse } from '../workers/protocol';

export { type SerializedArtifacts } from '../workers/protocol';

export class CompilationProxy {
  @observable
  public lastError: string | null = null;

  @observable
  public validationErrors: LogicValidationError[] = [];

  @observable
  public currentArtifacts: SerializedArtifacts | null = null;

  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, {
    resolve: (artifacts: SerializedArtifacts | null) => void;
  }>();

  constructor() {
    makeObservable(this);
    this.worker = new Worker(
      new URL('../workers/compilation-worker.ts', import.meta.url),
      { type: 'module' }
    );
    this.worker.onmessage = (e: MessageEvent<CompilationWorkerResponse>) => {
      this.handleMessage(e.data);
    };
  }

  public async compile(ir: IRDocument): Promise<SerializedArtifacts | null> {
    this.setLogicValidationErrors([]);
    this.setLastError(null);

    const id = this.nextId++;
    return new Promise<SerializedArtifacts | null>((resolve) => {
      this.pending.set(id, { resolve });
      this.worker.postMessage({ type: 'compile', id, ir: toJS(ir) });
    });
  }

  @action
  public swap(artifacts: SerializedArtifacts) {
    this.currentArtifacts = artifacts;
  }

  private handleMessage(msg: CompilationWorkerResponse) {
    if (msg.type === 'compiled') {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        entry.resolve(msg.artifacts);
      }
    } else if (msg.type === 'compile-error') {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        this.setLogicValidationErrors(msg.errors);
        this.setLastError(msg.message);
        entry.resolve(null);
      }
    }
  }

  @action
  private setLogicValidationErrors(errors: LogicValidationError[]) {
    this.validationErrors = errors;
  }

  @action
  private setLastError(error: string | null) {
    this.lastError = error;
  }

  public dispose() {
    this.worker.terminate();
  }
}
