# Implementation Plan - IR Scaffolding

We will now translate the design in `INTERMEDIATE_REPRESENTATION.md` into strict TypeScript definitions and validators.

## User Review Required
> [!IMPORTANT]
> This plan establishes the core data structures. Any changes to the JSON schema after this point will require refactoring `types.ts` and `schema.ts`.

## Proposed Changes

### IR Definition
#### [NEW] [types.ts](file:///Users/nattos/Code/nano-ffglify/src/ir/types.ts)
-   Define `DataType`, `ResourceSize`, `InputDef`, `ResourceDef`, `FunctionDef`, `Node`, `Edge`.
-   Define `IRDocument` as the root type.

#### [NEW] [schema.ts](file:///Users/nattos/Code/nano-ffglify/src/ir/schema.ts)
-   Implement Zod schemas matching `types.ts`.
-   **Critical**: Export a `validateIR(json: unknown): ValidationResult` function.
    -   Must collect **ALL** errors (structural and semantic), not just the first one.
    -   Return type: `{ success: true, data: IRDocument } | { success: false, errors: ValidationError[] }`.
    -   `ValidationError` should contain: `path` (string array), `message` (human readable), and `code` (error code).
    -   Include semantic checks (e.g., "Node references non-existent resource ID") beyond just basic type checking.

### Verification
#### [NEW] [ir.test.ts](file:///Users/nattos/Code/nano-ffglify/src/ir/ir.test.ts)
-   Test 1: Validate a minimal IR (empty functions).
-   Test 2: Validate the "Precomputed Blur" example from the design doc (full complex case).
-   Test 3: Validate the "Recursive Factorial" example.
-   Test 4: **Validation Assertions** - Construct invalid IRs and assert on specific error messages.
    -   Case: Missing Node ID -> Expect "Node at functions[0].nodes[2] is missing 'id'".
    -   Case: Invalid Resource Ref -> Expect "Node 'n_sample' references unknown resource 't_missing'".
    -   Case: Cycle detection (optional for now, but good to have).

## Future Outlook
> [!NOTE]
> Once the IR and Validator are stable, the next step will be building a **Reference Interpreter** to simulate execution on the CPU. This will act as the ground truth for checking backend (Metal/HLSL) correctness.

## Verification Plan

### Automated Tests
Run `npx vitest src/ir/ir.test.ts` to confirm the Types and Zod schemas correctly handle valid and invalid IRs.
