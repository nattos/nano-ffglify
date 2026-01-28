# Nano App Template ⚡️

A minimal, opinionated template for building Agentic Web Apps with LLM capabilities.

**Current Concept:** "Notes App" (Demo Implementation)

## 🌟 Features

-   **State Management**: Reactive state using `MobX` + `Immer` for immutable updates.
-   **UI Architecture**: Lightweight `Lit` components with explicit `AppController` actions.
-   **LLM Integration**: Built-in `ChatHandler` connected to Google Gemini, with robust Tool Calling for entity mutations.
-   **Persistence**: `IndexedDB` storage for both App Settings and Database State.
-   **Undo/Redo**: Full history stack for all database mutations.
-   **Debug Tools**:
    -   **Task Mode**: "Script" tab to run deterministic conversation flows for testing.
    -   **LLM Logs**: Live inspector of prompts and responses.
    -   **State View**: Full JSON tree verification.

## 🛠 Project Structure

```bash
src/
├── domain/        # Business Logic & Types
│   ├── types.ts   # Core Entity Definitions (e.g. Note)
│   ├── state.ts   # AppState Container
│   └── schemas.ts # LLM Tool Schemas
├── state/         # Interaction Layer
│   ├── controller.ts  # User Actions
│   ├── history.ts     # Undo/Redo Logic
│   └── entity-manager.ts # Entity Mutations
├── llm/           # Intelligence Layer
│   ├── llm-manager.ts # Google GenAI Client
│   └── chat-handler.ts # Conversation Logic
├── views/         # UI Components (Lit)
└── index.ts       # Application Entry
```

## 🚀 Getting Started

1.  **Clone & Install**
    ```bash
    npm install
    ```

2.  **Environment Setup**
    Create a `.env` file (or set in shell):
    ```bash
    GOOGLE_API_KEY=your_gemini_key
    VITE_DB_NAME=my-app-db # Required for persistence
    ```

3.  **Run Development Server**
    ```bash
    npm run dev
    ```

## � Anatomy of a Nano App

This template is designed to be forked. When building your own app (e.g., a Todo List, a CRM, a Game), you will primarily modify the **Domain Blueprints**.

### 📘 Domain Blueprints (Modify These)
*   **`src/domain/types.ts`**: Define your Data Model (Entities) and their LLM Schemas.
    *   *Example*: Replace `Note` with `Task` or `Customer`.
*   **`src/domain/prompt-builder.ts`**: Craft the System Persona and Few-Shot Examples.
    *   *Example*: Change "You are a Notes Assistant" to "You are a CRM Sales Bot".
*   **`src/domain/mock-responses.ts`**: Define deterministic test data for the Script Mode "Happy Path".
*   **`src/views/`**: Build your Lit-based UI components.

### ⚙️ Core Engine (Keep These)
*   **`src/state/*`**: The "Draft Pattern" state management, history, and persistence logic.
    *   `controller.ts`: Generic action handler.
    *   `entity-manager.ts`: Handles JSON Patch operations.
    *   `settings.ts`: Handles IndexedDB storage.
*   **`src/domain/schemas.ts`**: Generic utility for converting TypeScript types to LLM tool definitions.
*   **`src/llm/chat-handler.ts`**: The main conversation loop (User -> Prompt -> LLM -> Tool -> State).
*   **`src/llm/llm-manager.ts`**: Google GenAI client configuration.

## �🧠 Key Concepts

### 1. The "Draft" Pattern
Mutations are rarely direct. We use an `EntityManager` that routes changes through `AppController.mutate`. This ensures:
-   **History**: Every change is recorded in the Undo stack.
-   **Persistence**: Every change triggers an auto-save to IndexedDB.
-   **Reactivity**: The UI updates instantly via MobX.

### 2. LLM as a User
The LLM is treated as just another user who can invoke tools. `ChatHandler` translates user intent into calls like `upsertEntity` or `deleteEntity`, which flow through the exact same mutation pipeline as manual UI actions.

### 3. Task Mode (Scripting)
For rapid iteration, we use `AUTO_PLAY_SCRIPT_LINES` in `constants.ts`.
-   **Debug Mode**: Set to `0` or greater to auto-run specific lines of conversation on reload.
-   **Clean Slate**: When auto-playing, **Database Persistence is DISABLED** to prevent test runs from corrupting your actual data.

## 📦 Tech Stack

-   **Build**: Vite
-   **Framework**: Lit (Web Components)
-   **State**: MobX + Immer
-   **AI**: Google Generative AI SDK
-   **Storage**: idb (IndexedDB Wrapper)
