# Design Document: Nano FFGLify

## Concept
Nano FFGLify is an agentic chat application designed to streamline the production of FFGL (FreeFrame GL) plugins, including Effects, Sources, and Mixers. It leverages a browser-based REPL environment powered by WebGPU and WGSL to enable rapid iteration and accessibility.

Instead of writing raw shader code (GLSL/HLSL/MSL) directly, the system uses a **Graph-Based Intermediate Representation (IR)**. This IR abstracts the complexity of cross-platform shader development, allowing the system to:
1.  Visualize the logic as a "flow" or block diagram.
2.  Preview effects live in the browser using a WebGPU backend.
3.  Export native code for specific targets:
    -   **Metal** for macOS.
    -   **HLSL** for Windows.

## Core Features

### 1. Agentic Workflow
-   **Chat Interface**: Users interact with an LLM agent to describe desired effects.
-   **Graph Generation**: The agent generates or modifies the underlying Graph IR based on user prompts.
-   **Iterative Refinement**: The "Draft Pattern" (from the base definition) allows users to undo/redo changes to the graph logic.

### 2. Intermediate Representation (IR) Engine
The heart of the system is the IR, designed to be a "lingua franca" for GPU logic. (See `INTERMEDIATE_REPRESENTATION.md` for details).
-   **Nodes**: Basic math, sampling, logic, flow control.
-   **Stages**:
    -   **Compute**: General-purpose GPU compute kernels.
    -   **Render**: Vertex and Fragment stages for visual output.
-   **Data**: Typed inputs, textures, and persistent buffers (History).

### 3. Pipeline & Backends
-   **WebGPU Preview**: The primary "View" in the app. The IR is compiled JIT to WGSL for live feedback.
    -   Leverages copy-texture capabilities for multi-pass effects.
-   **Export Targets**:
    -   **Metal (.metal)**: For macOS FFGL plugins.
    -   **HLSL (.hlsl)**: For Windows FFGL plugins (DX11/DX12).

### 4. Advanced Capabilities
-   **GPGPU Features**: Utilization of compute shaders, atomics, and persistent storage buffers.
-   **History**: Easy access to previous frames (feedback loops) and CPU-side history.
-   **Recursion & Loops**: First-class support for complex control flow within the graph.

## Architecture

### Frontend
-   **Framework**: Lit (Web Components) + MobX.
-   **Visualization**: A node-graph editor/viewer (likely strictly a viewer or light editor initially, with the Agent doing the heavy lifting).

### "Compiler" Structure
The compiler is a TypeScript library running in the browser.
Input: `GraphIR (JSON)`
Output:
-   `WGSL Source` (for `wgpu` device)
-   `Metal Source` (text artifact)
-   `HLSL Source` (text artifact)

## Goal
To demonstrate that an LLM can effectively "write" complex GPU logic by manipulating a high-level graph structure rather than struggle with the syntax nuances of varying shader languages, while providing immediate visual feedback to the user.
