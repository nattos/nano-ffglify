/**
 * @file constants.ts
 * @description Global configuration constants.
 *
 * @external-interactions
 * - Controls `AUTO_PLAY_SCRIPT_LINES` which alters boot behavior (disables persistence).
 * - `DEFAULT_LLM_MODEL`: Sets the Gemini model version.
 *
 * @pitfalls
 * - Changing `AUTO_PLAY_SCRIPT_LINES` requires a page reload to take effect properly.
 */

// -1 to play all lines.
export const AUTO_PLAY_SCRIPT_LINES: number | undefined = undefined;
export const DEFAULT_LLM_MODEL = "gemini-3-flash-preview";
export const CHAT_HISTORY_LENGTH = 20;

export const PATCH_SIZE = {
  width: 1920,
  height: 1080
};
