# Nano FFGLify ⚡️

A specialized Agentic Web App for designing and compiling WebGPU Shader Graphs using an Intermediate Representation (IR).

**Current Concept:** "Shader IR Assistant" (Active Implementation)

## 🌟 Features

-   **State Management**: Reactive state using `MobX` + `Immer`. The primary entity is the `IRDocument`.
-   **IR Architecture**: Built on a directed graph of nodes and edges, supporting both CPU orchestration and WebGPU compute/fragment shaders.
-   **LLM Integration**: `WebGPU IR Assistant` connected to Google Gemini, trained to manipulate the shader IR via `upsertIR` and `patchIR` tools.
-   **On-the-fly Compilation**:
    -   **JS JIT**: Compiles CPU logic to executable JavaScript.
    -   **WGSL**: Generates high-performance WebGPU shader code from the graph.
-   **Validation**: Real-time static logic validation (type matching, resource binding checks) integrated into the UI.
-   **Persistence**: Full persistence of the IR and chat history via `IndexedDB`.
-   **Persistence Policy**: Structural validation is enforced on save, but logical "mistakes" are allowed and surfaced via the Diagnostics UI.

## 🛠 Project Structure

```bash
src/
├── domain/        # Blueprints
│   ├── types.ts   # IR Schema & App State
│   ├── state.ts   # Initial State
│   └── verifier.ts # Structural Validation
├── ir/            # Core Engine
│   ├── types.ts   # IR Language Definition
│   └── validator.ts # Static Logic Analysis
├── webgpu/        # Backend
│   ├── cpu-jit.ts # Host JS Compiler
│   └── wgsl-generator.ts # WGSL Transpiler
├── state/         # Interaction Layer
│   ├── controller.ts # Actions (Validate/Compile)
│   └── entity-api.ts # Tool Types
├── llm/           # Intelligence Layer
│   ├── llm-manager.ts # Gemini Client
│   └── chat-handler.ts # Tool Execution Loop
├── views/         # UI (Lit)
└── index.ts       # Application Entry
```

## 🚀 Getting Started

1.  **Install Dependencies**
    ```bash
    npm install
    ```

2.  **Run Development Server**
    ```bash
    npm run dev
    ```

3.  **Environment Variables**
    - `GOOGLE_API_KEY`: Required for LLM functionality.
    - `VITE_DB_NAME`: Database namespace.

## ⚙️ Compilation Pipeline

The app transforms a high-level `IRDocument` into executable artifacts:

1.  **Validation**: `validator.ts` performs deep static analysis of the graph.
2.  **JS Generation**: `cpu-jit.ts` emits a host function that manages buffers, textures, and dispatches.
3.  **WGSL Generation**: `wgsl-generator.ts` emits `@compute` or `@fragment` shaders for each shader node in the graph.

## 📦 Tech Stack

-   **Build**: Vite
-   **Framework**: Lit (Web Components)
-   **State**: MobX + Immer
-   **AI**: Google Generative AI SDK
-   **Compute**: WebGPU (via WGSL)
-   **Host**: JavaScript (JIT)
-   **Storage**: IndexedDB (via idb)
