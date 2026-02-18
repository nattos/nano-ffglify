import { ReplManager } from '../../runtime/repl-manager';
import { RuntimeManager } from '../../runtime/runtime-manager';
import { getSharedDevice } from '../../webgpu/gpu-device';
import { IRDocument } from '../../ir/types';

interface CompileCommand {
  type: 'compile';
  ir: IRDocument;
}

interface StepCommand {
  type: 'step';
}

interface ReadbackCommand {
  type: 'readback';
  resourceId?: string; // defaults to primary output
}

type Command = CompileCommand | StepCommand | ReadbackCommand;

interface ReadbackResult {
  resourceId: string;
  pixels: number[][];
  width: number;
  height: number;
}

interface TestResult {
  readbacks: ReadbackResult[];
  errors: string[];
}

/**
 * Browser-side bridge for RuntimeManager + ReplManager integration tests.
 * Exposes window.runRuntimeLoopTest(commands) for Puppeteer to call.
 */
(window as any).runRuntimeLoopTest = async (commands: Command[]): Promise<TestResult> => {
  const repl = new ReplManager();
  const runtime = new RuntimeManager();
  const device = await getSharedDevice();

  const result: TestResult = { readbacks: [], errors: [] };

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'compile': {
        try {
          const artifacts = await repl.compile(cmd.ir);
          if (!artifacts) {
            result.errors.push(repl.lastError || 'Compilation returned null');
            break;
          }
          repl.swap(artifacts);
          await runtime.setCompiled(artifacts, device);
        } catch (e: any) {
          result.errors.push(e.message || String(e));
        }
        break;
      }

      case 'step': {
        try {
          // Call executeFrame() directly — it's private and async.
          // The public step() pauses and calls executeFrame() without awaiting.
          await (runtime as any).executeFrame();
        } catch (e: any) {
          result.errors.push(e.message || String(e));
        }
        break;
      }

      case 'readback': {
        try {
          const host = (runtime as any).host;
          const resources = (runtime as any).resources as Map<string, any>;
          if (!host || !resources) {
            result.errors.push('Runtime not initialized (no host/resources)');
            break;
          }

          const resourceId = cmd.resourceId || runtime.getPrimaryOutputId();
          if (!resourceId) {
            result.errors.push('No output resource found');
            break;
          }

          // Trigger GPU → staging copy, then wait for it
          host.executeSyncToCpu(resourceId);
          await host.executeWaitCpuSync(resourceId);

          const res = resources.get(resourceId);
          if (!res) {
            result.errors.push(`Resource '${resourceId}' not found`);
            break;
          }

          result.readbacks.push({
            resourceId,
            pixels: res.data ?? [],
            width: res.width,
            height: res.height,
          });
        } catch (e: any) {
          result.errors.push(e.message || String(e));
        }
        break;
      }
    }
  }

  return result;
};

(window as any).runtimeBridgeReady = true;
