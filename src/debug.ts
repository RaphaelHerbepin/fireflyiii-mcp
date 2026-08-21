/**
 * Debug tracing, in its own module rather than in `tools/_helpers.ts`.
 *
 * The projection layer needs to report entities it has no presets for, and `_helpers.ts` needs the
 * projection layer to apply `fields` inside `defineTool`. Leaving `debugLog` in `_helpers.ts` makes
 * those two modules import each other. ESM tolerates the cycle, but it is the kind of thing that
 * breaks later for reasons nobody connects to this decision.
 */

const DEBUG_ENABLED = process.env.FIREFLY_DEBUG === 'true' || process.env.FIREFLY_DEBUG === '1';

/**
 * Writes to stderr only when FIREFLY_DEBUG is set. Never touches stdout, so it is safe under the
 * stdio transport, where stdout carries the protocol. Used for the verbose autocomplete tracing that
 * would otherwise fire on every keystroke — and echo user search terms — in normal operation.
 */
export function debugLog(...args: unknown[]): void {
  if (DEBUG_ENABLED) console.error(...args);
}
