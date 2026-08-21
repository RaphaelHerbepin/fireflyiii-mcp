/**
 * Removes credentials and account identifiers from anything on its way to a log.
 *
 * Masking is driven by key name first, pattern second, and that order is deliberate. A regex broad
 * enough to catch account numbers by shape — long digit runs — also catches transaction ids, budget
 * ids and amounts, which makes debug output useless and hides the very thing you turned it on to see.
 * Key names are exact and cost nothing. Patterns are reserved for values that appear inside free text,
 * where no key is available: IBANs and bearer tokens in an error message or a URL.
 */

/** Keys whose value is sensitive whatever it looks like. */
const SENSITIVE_KEYS =
  /^(iban|account_number|number|token|access_token|refresh_token|authorization|password|secret|client_secret|api_key)$/i;

/** An IBAN: two letters, two check digits, then up to 30 alphanumerics, optionally in groups of four. */
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;

/** A JWT — the shape of a Firefly III personal access token. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Any `Bearer <credential>`, for tokens that are not JWTs. */
const BEARER_RE = /\b([Bb]earer\s+)\S+/g;

export const REDACTED = '[redacted]';

/** Depth and breadth caps: this runs on a debug path and must never become the dominant cost. */
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;

export function redactString(value: string): string {
  return value.replace(JWT_RE, REDACTED).replace(BEARER_RE, `$1${REDACTED}`).replace(IBAN_RE, REDACTED);
}

/**
 * Walks a value, masking sensitive keys and patterns. Structure is preserved so a redacted payload
 * still reads like the original — a log entry saying only `[redacted]` helps nobody debug anything.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEYS.test(key) ? REDACTED : redact(entry, depth + 1, seen);
  }
  return result;
}
