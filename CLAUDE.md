# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nano FFGLify is an agentic web application for designing and compiling WebGPU shader graphs. Users describe effects via a chat interface backed by Google Gemini, which manipulates a graph-based Intermediate Representation (IR). The IR compiles to WGSL for live browser preview, with export targets for Metal (macOS) and HLSL (Windows) for FFGL plugin generation.

## Build & Test Commands

```bash
npm run dev          # Start Vite dev server with hot reload
npm run build        # TypeScript check + Vite production build
npm test             # Run unit tests (Vitest, jsdom environment)
npm run test:e2e     # Run e2e tests (Jest + Puppeteer)
```

To run a single test file: `npx vitest --run path/to/file.test.ts`

Test files live in `test/` (integration tests) and alongside source files as `*.test.ts` (unit tests).

## Environment Variables

- `GOOGLE_API_KEY`: Required for Gemini LLM functionality
- `VITE_DB_NAME`: Database namespace (defaults to `'nano-ffglify'`)

## Architecture

### Layers

- **`src/domain/`** — App-level data model (`AppState`, `IRDocument`), LLM tool schema generation, structural validation, mock LLM responses
- **`src/ir/`** — IR type definitions, static validator (type inference + error reporting), operation signatures and built-in definitions
- **`src/webgpu/`** — WGSL code generator, CPU JIT compiler (IR → JavaScript for host control flow), shader layout, GPU device management, caching
- **`src/state/`** — Central mutation dispatcher (`AppController`), entity CRUD (`EntityManager`), undo/redo history, IndexedDB persistence
- **`src/llm/`** — Gemini API wrapper (`LLMManager`), conversation loop with tool execution (`ChatHandler`)
- **`src/interpreter/`** — Reference CPU-based IR executor for compliance testing
- **`src/metal/`** — Metal Shading Language (MSL) and C++ code generation
- **`src/views/`** — Lit Web Components with MobX reactivity integration
- **`src/runtime/`** — Execution orchestration and REPL management

### Compilation Pipeline

1. **Validation** — `src/ir/validator.ts` performs static analysis: type inference, edge validation, resource binding checks. Returns `LogicValidationError[]`.
2. **JS Generation** — `src/webgpu/cpu-jit.ts` compiles CPU functions to executable JavaScript (buffer management, dispatch orchestration).
3. **WGSL Generation** — `src/webgpu/wgsl-generator.ts` emits `@compute` or `@fragment` shaders from shader-type functions.

### IR Design (Property-Based Graph)

The IR uses **property-based connectivity** rather than explicit adjacency lists. Node properties like `exec_in`, `exec_out`, `exec_true`, `exec_false`, `exec_body` define execution flow. Data flow is defined by referencing other node IDs in value properties (e.g., `"a": "other_node_id"`). Edges are reconstructed implicitly via `reconstructEdges()` in `src/ir/utils.ts`.

Key constraints:
- `localVars` only support POD types (scalars, vectors) — resources (textures, buffers) cannot be stored in variables
- Resources are accessed by global ID string, not by reference
- WGSL does not support recursion; the compiler must unroll or reject

See `docs/INTERMEDIATE_REPRESENTATION.md` for the full IR spec with examples.

### State Management Pattern

- **MobX** for reactive state, **Immer** for immutable updates, **IndexedDB** for persistence
- `appState` singleton splits into `database` (persistent) and `local` (ephemeral)
- All database mutations go through `appController.mutate()` — never modify `appState.database` directly
- This bottleneck enables undo/redo, auto-save, and validation integration

### LLM Tool Integration

The LLM interacts with the IR via tools (`replaceIR`, `patchIR`, `queryDocs`, `final_response`). Tool schemas are generated from TypeScript types in `src/domain/schemas.ts`, producing both JSON Schema and Gemini `FunctionDeclaration` objects. The compilation pipeline runs automatically after tool edits, and validation/compile errors are returned to the LLM for self-correction.

## Key Files

- `src/ir/types.ts` — IR schema definition (all node types, data types, function definitions)
- `src/ir/validator.ts` — Static analysis engine (type inference, validation)
- `src/ir/signatures.ts` — Operation signatures defining inputs/outputs/types for each opcode
- `src/webgpu/wgsl-generator.ts` — IR → WGSL transpiler
- `src/webgpu/cpu-jit.ts` — IR → JavaScript host compiler
- `src/state/controller.ts` — Central mutation dispatcher
- `src/llm/chat-handler.ts` — Agentic conversation loop
- `src/domain/types.ts` — App state model
- `src/domain/schemas.ts` — LLM tool definition generation

## Conventions

- TypeScript strict mode is the primary quality gate (no ESLint/Prettier configured)
- UI components use `ui-` prefix (e.g., `ui-button.ts`, `ui-viewport.ts`)
- Manager/handler pattern: `*-manager.ts`, `*-handler.ts`
- Two validation levels: `ValidationError` (structural/schema) and `LogicValidationError` (semantic/type analysis)
