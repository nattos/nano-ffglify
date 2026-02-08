import { DatabaseState } from '../domain/types';
import { AppController } from '../state/controller';
import { toJS } from 'mobx';
import { createIsolatedEnv } from './isolation';

/**
 * A lightweight reducer that applies LLM Tool Calls to a DatabaseState object.
 * Used for simulating state evolution in the Debug Script Runner.
 *
 * Uses the actual application logic via dependency injection.
 */
export async function applyToolToState(state: DatabaseState, toolName: string, args: any): Promise<{ entityType: string, entity: any } | null> {
  try {
    // 1. Setup Request-Scoped DI Container
    const { chatHandler, appState } = createIsolatedEnv(state);

    // 2. Execute
    const result = await chatHandler.executeTool(toolName, args);

    if (result.response.success) {
      // 3. Extract Result
      // The tool name often tells us the type, or args does.
      let entityType = args.entity_type;

      // To get the updated entity, we intercept the `addChatMessage` call
      // which ChatHandler uses to report success.

      let capture: { entityType: string, entity: any } | null = null;

      const capturingController = {
        addChatMessage: (msg: any) => {
          if (msg.type === 'entity_update' && msg.data?.entity) {
            capture = {
              entityType: msg.data.entityType,
              entity: toJS(msg.data.entity)
            };
          }
        },
        logLLMInteraction: () => { }
      } as unknown as AppController;

      // Re-instantiate with capturing controller
      // PERF: This is double instantiation, but for replay it's fine.
      // Actually, we can just pass the capturing controller to the first one if we construct it first.
      const envWithCapture = createIsolatedEnv(state, { controller: capturingController });
      envWithCapture.chatHandler.executeTool(toolName, args);

      return capture;
    }

  } catch (e) {
    console.error("[Replay] Error applying tool:", toolName, e);
  }
  return null;
}
