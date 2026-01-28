/**
 * @file isolation.ts
 * @description Factory for creating isolated Dependency Injection containers.
 * Used to run scripts in a "sandbox" without affecting the main AppState.
 *
 * @external-interactions
 * - Creates ephemeral instances of `AppState`, `EntityManager`, `ChatHandler`.
 *
 * @pitfalls
 * - Mocks must be kept in sync with the real classes. if `AppController` adds a new method, the mock here needs to simulate it (or at least ignore it).
 */
import { DatabaseState } from '../domain/types';
import { AppState } from '../domain/state';
import { HistoryManager } from '../state/history';
import { EntityManager } from '../state/entity-manager';
import { ChatHandler } from '../llm/chat-handler';
import { LLMManager } from '../llm/llm-manager';
import { AppController } from '../state/controller';

export interface IsolatedEnv {
  appState: AppState;
  historyManager: HistoryManager;
  entityManager: EntityManager;
  chatHandler: ChatHandler;
  mockController: AppController;
  mockLLM: LLMManager;
}

export function createIsolatedEnv(
  initialState: DatabaseState,
  overrides?: {
    controller?: Partial<AppController>;
    llm?: Partial<LLMManager>;
  }
): IsolatedEnv {
  // 1. Clone State
  const isolatedDb = JSON.parse(JSON.stringify(initialState)) as DatabaseState;
  const mockAppState = new AppState(isolatedDb);

  // 2. Components
  const mockHistory = new HistoryManager(mockAppState);

  // 3. Mocks
  const mockController = (overrides?.controller || {
    addChatMessage: () => { /* No-op */ },
    logLLMInteraction: () => { /* No-op */ },
    mutate: (desc: string, src: string, recipe: any) => {
      // Rudimentary mock for mutate in isolation
      // We *do* want to apply patches to isolated history if we want full fidelity
      mockHistory.record(desc, src as any, recipe);
    }
  }) as unknown as AppController;

  const mockEntityManager = new EntityManager(mockAppState, mockController);

  const mockLLM = (overrides?.llm || {
    generateResponse: async () => ({})
  }) as unknown as LLMManager;

  const chatHandler = new ChatHandler(
    mockController,
    mockAppState,
    mockLLM,
    mockEntityManager
  );

  return {
    appState: mockAppState,
    historyManager: mockHistory,
    entityManager: mockEntityManager,
    chatHandler,
    mockController,
    mockLLM
  };
}
