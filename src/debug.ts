/**
 * Debug tracing, in its own module rather than in `tools/_helpers.ts`.
 *
 * The projection layer needs to report entities it has no presets for, and `_helpers.ts` needs the
 * projection layer to apply `fields` inside `defineTool`. Leaving `debugLog` in `_helpers.ts` makes
 * those two modules import each other. ESM tolerates the cycle, but it is the kind of thing that
 * breaks later for reasons nobody connects to this decision.
 */

import { redact } from './redact.js';

const DEBUG_ENABLED = process.env.FIREFLY_DEBUG === 'true' || process.env.FIREFLY_DEBUG === '1';

/**
 * Writes to stderr only when FIREFLY_DEBUG is set. Never touches stdout, so it is safe under the
 * stdio transport, where stdout carries the protocol. Used for the verbose autocomplete tracing that
 * would otherwise fire on every keystroke — and echo user search terms — in normal operation.
 *
 * Everything is passed through {@link redact} first. Debug output on a finance server routinely holds
 * whole account records, and "it is only written when debugging" is not a reason to write an IBAN to
 * a terminal, a CI log or a bug report attachment.
 */
export function debugLog(...args: unknown[]): void {
  if (DEBUG_ENABLED) console.error(...args.map((arg) => redact(arg)));
}
