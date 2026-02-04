/**
 * @file controller.ts
 * @description The main entry point for User and System actions.
 * Orchestrates inputs from the UI, delegates to `EntityManager` for mutations, and triggers History recording.
 *
 * @external-interactions
 * - `addChatMessage`: Updates UI state and persists chat interactions.
 * - `mutate`: The central bottleneck for Database mutations, wrapping them in History and Persistence calls.
 * - Usage: `appController.undo()` or `appController.mutate(...)`.
 *
 * @pitfalls
 * - Do NOT modify `appState.database` directly from views or other services. ALWAYS use `appController.mutate` (or `entityManager` which calls `mutate`).
 * - Direct modification bypasses Undo/Redo and Auto-Save.
 */
import { runInAction, toJS } from 'mobx';
import { appState } from '../domain/state';
import { ChatMsg, LLMLogEntry, IRDocument } from '../domain/types';
import { historyManager } from './history';
import { settingsManager } from './settings';
import { validateIR } from '../ir/validator';
import { CpuJitCompiler } from '../webgpu/cpu-jit';
import { WgslGenerator } from '../webgpu/wgsl-generator';
import { getSharedDevice } from '../webgpu/gpu-device';
import { fetchAndDecodeImage, encodeAndDownloadImage } from '../utils/image-utils';
import { EvaluationContext } from '../interpreter/context';
import { WebGpuHostExecutor } from '../webgpu/webgpu-host-executor';
import { TextureFormat } from '../ir/types';

export class AppController {
  public setActiveTab(tab: 'state' | 'logs' | 'script' | 'results') {
    runInAction(() => {
      appState.local.settings.activeTab = tab;
    });
    settingsManager.saveSettings(toJS(appState.local.settings));
  }

  public setChatOpen(open: boolean) {
    runInAction(() => {
      appState.local.settings.chatOpen = open;
    });
    settingsManager.saveSettings(toJS(appState.local.settings));
  }

  public toggleMockLLM(useMock: boolean) {
    runInAction(() => {
      appState.local.settings.useMockLLM = useMock;
    });
    settingsManager.saveSettings(toJS(appState.local.settings));
  }

  public logLLMInteraction(entry: LLMLogEntry) {
    console.log("[AppController] Logging LLM Interaction:", entry);
    runInAction(() => {
      appState.local.llmLogs.unshift(entry);
      // Cap logs to 50
      if (appState.local.llmLogs.length > 50) {
        appState.local.llmLogs.length = 50;
      }
    });
  }

  private saveDatabase() {
    settingsManager.saveDatabase(toJS(appState.database));
  }

  public undo() {
    historyManager.undo();
    this.saveDatabase();
  }

  public redo() {
    historyManager.redo();
    this.saveDatabase();
  }

  public clearLogs() {
    runInAction(() => {
      appState.local.llmLogs.length = 0;
    });
  }

  public setDraftChat(text: string) {
    runInAction(() => {
      appState.local.draftChat = text;
    });
  }

  public setActiveRewindId(id: string | null) {
    runInAction(() => {
      appState.local.activeRewindId = id;
    });
  }

  public setSelectedEntity(id: string | null, type?: 'IR') {
    // Standard select resets history (Breadcrumbs)
    runInAction(() => {
      appState.local.selectionHistory = [];
      appState.local.selectionFuture = [];
      if (!id) {
        appState.local.selectedEntity = undefined;
      } else if (type) {
        appState.local.selectedEntity = { id, type };
      }
    });
  }

  public drillDown(id: string, type: 'IR') {
    runInAction(() => {
      if (appState.local.selectedEntity) {
        // Push current to history
        appState.local.selectionHistory.push(appState.local.selectedEntity);
        // New branch clears future
        appState.local.selectionFuture = [];
      }
      appState.local.selectedEntity = { id, type };
    });
  }

  public validateCurrentIR() {
    console.info("[AppController] Validating IR...");
    const ir = appState.database.ir;
    const errors = validateIR(ir);
    runInAction(() => {
      appState.local.validationErrors = errors;
      this.setActiveTab('results');
    });
  }

  public compileCurrentIR() {
    console.info("[AppController] Compiling IR...");
    const ir = appState.database.ir;
    const cpuJit = new CpuJitCompiler();
    const wgslGen = new WgslGenerator();

    try {
      const js = cpuJit.compileToSource(ir, ir.entryPoint);
      const wgsl: Record<string, string> = {};

      ir.functions.forEach(f => {
        if (f.type === 'shader') {
          wgsl[f.id] = wgslGen.compile(ir, f.id).code;
        }
      });

      runInAction(() => {
        appState.local.compilationResult = { js, wgsl };
        this.setActiveTab('results');
      });
    } catch (e: any) {
      console.error(e);
      alert("Compilation failed: " + e.message);
    }
  }

  public async runOne() {
    console.info("[AppController] Running One...");
    const ir = appState.database.ir;

    try {
      // 1. Get GPU Device
      const device = await getSharedDevice();

      // 2. Fetch and Decode Input Image
      const inputAsset = await fetchAndDecodeImage('test.png');

      // 3. Create Evaluation Context
      const inputs = new Map<string, any>();
      // Use defaults for scalar inputs, but we specifically need t_input
      ir.inputs.forEach(inp => {
        if (inp.default !== undefined) {
          inputs.set(inp.id, inp.default);
        }
      });
      inputs.set('u_kernel_size', 16); // Fallback for blur demo if not set

      const ctx = new EvaluationContext(ir, inputs);

      // 4. Populate t_input resource with image data
      const tInput = ctx.getResource('t_input');
      if (tInput) {
        tInput.width = inputAsset.width;
        tInput.height = inputAsset.height;
        tInput.data = inputAsset.data;
      }

      // 5. Initialize other resources (ensure they exist and have initial sizes)
      // For textures that reference t_input, resize them
      ir.resources.forEach(res => {
        const state = ctx.getResource(res.id);
        if (res.size.mode === 'reference' && res.size.ref === 't_input') {
          state.width = inputAsset.width;
          state.height = inputAsset.height;
        }
      });

      // 6. Setup Executors
      const hostExec = new WebGpuHostExecutor(ctx, device);

      // 7. Execute JIT starting at entry point
      const entryFunc = ir.functions.find(f => f.id === ir.entryPoint);
      if (!entryFunc) throw new Error("Entry point not found");

      ctx.pushFrame(ir.entryPoint);
      await hostExec.executeFunction(entryFunc, ir.functions);

      // [TEMP] Explicit readback for debug
      // await gpuExec.readbackResource('t_output');

      // 8. Extract t_output and Download
      const tOutput = ctx.getResource('t_output');
      if (!tOutput || !tOutput.data) {
        throw new Error("t_output not found or has no data after execution");
      }

      await encodeAndDownloadImage(tOutput.data as number[][], tOutput.width, tOutput.height, 'result.png');
      console.info("[AppController] Run One completed successfully!");
      alert("Run One completed! Downloaded result.png");

    } catch (e: any) {
      console.error(e);
      alert("Run One failed: " + e.message);
    }
  }

  public goBack() {
    runInAction(() => {
      const prev = appState.local.selectionHistory.pop();
      if (prev) {
        if (appState.local.selectedEntity) {
          appState.local.selectionFuture.push(appState.local.selectedEntity);
        }
        appState.local.selectedEntity = prev;
      } else {
        // If history empty, we might act as "close", but for now just clear
        appState.local.selectedEntity = undefined;
        appState.local.selectionFuture = []; // Clear future if we exited?
      }
    });
  }

  public goForward() {
    runInAction(() => {
      const next = appState.local.selectionFuture.pop();
      if (next) {
        if (appState.local.selectedEntity) {
          appState.local.selectionHistory.push(appState.local.selectedEntity);
        }
        appState.local.selectedEntity = next;
      }
    });
  }

  public rewindToChat(targetId: string) {
    // 1. Find message text
    const history = appState.database.chat_history;
    const msg = history.find(m => m.id === targetId);
    if (!msg) return;

    // 2. Set draft
    if (msg.role === 'user' && msg.text) {
      this.setDraftChat(msg.text);
    }

    // 3. Undo loop
    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
      const currentHistory = appState.database.chat_history;
      const exists = currentHistory.some(m => m.id === targetId);

      if (!exists) {
        break; // Target removed!
      }

      // Perform undo
      this.undo();
      attempts++;
    }

    // Clear active rewind
    this.setActiveRewindId(null);
  }

  public mutate(description: string, source: 'user' | 'llm', recipe: (draft: import('../domain/types').DatabaseState) => void) {
    runInAction(() => {
      historyManager.record(description, source, recipe);
      this.saveDatabase();
    });
  }

  public addChatMessage(msg: Partial<ChatMsg>) {
    // ... (rest of method)
    // Ensure ID exists
    const fullMsg: ChatMsg = {
      id: msg.id || crypto.randomUUID(),
      role: msg.role || 'assistant',
      text: msg.text,
      type: msg.type,
      data: msg.data
    };

    runInAction(() => {
      historyManager.record('New Chat Message', fullMsg.role === 'user' ? 'user' : 'llm', (draft) => {
        if (!draft.chat_history) draft.chat_history = [];

        // Deduplication Logic for Entity Updates
        if (fullMsg.type === 'entity_update' && fullMsg.data?.entity?.id) {
          draft.chat_history = draft.chat_history.filter(m => {
            if (m.type === 'entity_update' && m.data?.entity?.id === fullMsg.data.entity.id) {
              return false; // Remove old card
            }
            return true;
          });
        }

        draft.chat_history.push(fullMsg);
      });
      // Save after mutation
      this.saveDatabase();
    });
  }
}

export const appController = new AppController();
