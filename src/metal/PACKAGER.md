# FFGL Packager Plan

## Objective
Create a "one-click" build system that packages the FFGL plugin and all its dependencies into a zip file. This process should be driven by a generated bash script to ensure transparency and portability.

## Phasing

### Phase 1: Script Generation (Completed)
- [x] Refactor `metal-compile.ts` to separate command generation from execution.
- [x] Create `generateBuildScript` function that outputs a bash script string.
- [x] Update tests to verify the generated script correctness and then execute it.

### Phase 2: packaging
- Add a step to the build script to copy all artifacts (bundle, readme, license) to a distribution folder.
- Add a step to zip the distribution folder.

### Phase 3: Integration
- Create a user-facing action (e.g., a "Export FFGL Plugin" button) that triggers this flow.
- Ensure the script handles different environments (dev paths vs prod paths) if necessary.

## Implementation Details for Phase 1

### `src/metal/metal-compile.ts`
- Introduce `generateCppCompileCmd` and `generateFFGLPluginCmd` which return strings.
- Create `generateBuildScript(options)` that combines these commands into a full bash script.
- The script should:
    - Set `set -e` to fail on error.
    - Echo steps for better logging.
    - Handle directory creation.
    - Compile Metal shaders.
    - Compile C++ host code (if needed).
    - Compile and link the FFGL plugin.
    - Code sign the bundle.
    - Create `Info.plist`.

### `src/metal/ffgl-build.test.ts`
- Instead of calling `compileFFGLPlugin` directly, call `generateBuildScript`.
- Write the script to a temp file (e.g., `build.sh`).
- `chmod +x build.sh`.
- Execute `build.sh`.
- Assert that the output bundle exists and works as expected.
