# Implementation Plan - Reference Interpreter

We will build a CPU-side reference interpreter to "run" the IR. This will not execute actual GPU shaders but will simulate the CPU orchestration logic (dispatching commands, resizing resources, branching).

## Proposed Changes

### 1. Interpreter Core (`src/interpreter/`)

#### [NEW] [context.ts](file:///Users/nattos/Code/nano-ffglify/src/interpreter/context.ts)
-   `RuntimeValue`: Union of supported runtime types (number, float4, etc.).
-   `ActionLog`: A simple array to record side-effects (e.g., `{ type: 'dispatch', func: 'fn_blur' }`).
-   `EvaluationContext`: Holds:
    -   `ir`: The full document.
    -   `vars`: Map of current local variables.
    -   `resources`: Map of resource states (size, etc.).
    -   `log`: The ActionLog.

#### [NEW] [ops.ts](file:///Users/nattos/Code/nano-ffglify/src/interpreter/ops.ts)
-   `OpRegistry`: A dictionary mapping OpCodes (string) to JS functions.
-   Implement standard math ops (`math_add`, `math_div_scalar`).
-   Implement resource ops (`resource_get_size`, `cmd_resize_resource`).
-   **Note**: CPU flow ops (`flow_branch`, `flow_loop`) are handled by the executor, not simple ops.

#### [NEW] [executor.ts](file:///Users/nattos/Code/nano-ffglify/src/interpreter/executor.ts)
-   `executeGraph(funcId: string, context)`: The main loop.
-   Algorithm:
    1.  Start at nodes without execution input (or specific Entry Point).
    2.  Traverse `execution` edges.
    3.  For each node:
        *   Resolve inputs (Data Edges) recursively or via cached values.
        *   Execute Op.
        *   Follow `flow_branch` / `flow_loop` logic.

### 2. Verification

#### [NEW] [interpreter.test.ts](file:///Users/nattos/Code/nano-ffglify/src/interpreter/interpreter.test.ts)
-   Test: Run the "Precomputed Blur" IR.
-   Assertions:
    1.  `log` should show `cmd_resize_resource` was called for `b_weights`.
    2.  `log` should show `cmd_dispatch(fn_gen_kernel)` happened first.
    3.  `log` should show `cmd_dispatch(fn_blur)` happened second.
    4.  Verify that `cmd_blur` dispatch dimensions were correctly calculated (Input Size / 8).
