import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatError } from '../client.js';
import { debugLog } from '../debug.js';
import { projectItem, projectUnwrappedList } from '../projection.js';
import type { FieldSelector, UnwrappedList, UnwrappedSingle } from '../transform.js';
import type { ToolAnnotations } from './_annotations.js';
import { NO_PROJECTION, TOOL_PROJECTIONS } from './_projection.js';

// Re-exported so the thirteen existing call sites keep importing it from here.
export { debugLog };

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
  /**
   * Required, not optional. The read-only filter reads `readOnlyHint` from here, so an unannotated
   * tool has no safety classification at all — and tsc is a better place to discover that than a
   * production server quietly exposing a write tool to a read-only client.
   */
  annotations: ToolAnnotations;
};

/**
 * The `fields` parameter, added to every projected read tool.
 *
 * Declared once here rather than in each tool's schema: there are 26 of them, and a description this
 * long copied 26 times would drift. `.default()` puts the default in the published JSON Schema, so a
 * model can see what it gets without being told.
 */
function fieldsSchema(defaultPreset: string): z.ZodTypeAny {
  return z
    .union([z.enum(['compact', 'standard', 'full']), z.array(z.string())])
    .optional()
    .default(defaultPreset as 'compact' | 'standard' | 'full')
    .describe(
      'Which fields to return. "compact" keeps only what budget analysis needs; "standard" adds tags, ' +
        'notes and reconciliation; "full" returns every field the API provides. You may also pass an ' +
        `explicit array of field names. "id" is always included. Defaults to "${defaultPreset}".`,
    );
}

export function defineTool(
  server: McpServer,
  name: string,
  config: ToolConfig,
  fetch: (args: Record<string, unknown>) => Promise<unknown>,
): void {
  const projection = TOOL_PROJECTIONS[name];
  const projects = projection !== undefined && projection !== NO_PROJECTION;

  if (projects) {
    if (config.inputSchema && 'fields' in config.inputSchema) {
      // Registration-time rather than runtime: a tool declaring its own `fields` would silently lose
      // one of the two meanings, and the loser would depend on property order.
      throw new Error(
        `Tool "${name}" declares an input named "fields", which collides with the projection ` +
          'parameter. Rename it, or mark the tool NO_PROJECTION in src/tools/_projection.ts.',
      );
    }
    config = { ...config, inputSchema: { ...config.inputSchema, fields: fieldsSchema(projection.default) } };
  }

  // registerTool is generic in the SDK; the cast avoids fighting its complex overload resolution
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool(name, config, async (args: Record<string, unknown>) => {
    try {
      // `fields` is consumed here; handlers never see it and stay unaware projection exists.
      const { fields, ...rest } = args;
      const result = await fetch(projects ? rest : args);

      if (!projects || typeof result === 'string' || result === null || result === undefined) {
        return {
          content: [
            {
              type: 'text' as const,
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      const selector = (fields ?? projection.default) as FieldSelector;
      // Project first, then guard. Guarding first would drop rows that would have fitted once
      // projected, leaving the caller with a needlessly partial set.
      const shaped =
        projection.kind === 'list'
          ? guardResponseSize(projectUnwrappedList(projection.entity, result as UnwrappedList, selector))
          : projectItem(projection.entity, result as UnwrappedSingle, selector);

      return { content: [{ type: 'text' as const, text: JSON.stringify(shaped, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: formatError(err) }], isError: true };
    }
  });
}

/** A pre-built MCP tool result. Used by tools that return native content blocks
 * (e.g. an `image` block) instead of letting {@link defineTool} JSON-stringify a
 * plain value into a single text block. */
export type ContentResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
};

/**
 * Like {@link defineTool}, but the handler returns a ready-made MCP result
 * (content blocks) rather than a plain value. Error handling is identical:
 * thrown errors become an `isError` text block via {@link formatError}.
 */
export function defineContentTool(
  server: McpServer,
  name: string,
  config: ToolConfig,
  fetch: (args: Record<string, unknown>) => Promise<ContentResult>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool(name, config, async (args: Record<string, unknown>) => {
    try {
      return await fetch(args);
    } catch (err) {
      return { content: [{ type: 'text' as const, text: formatError(err) }], isError: true };
    }
  });
}

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const dateTimeSchema = z.iso.datetime({ offset: true });
export const dateOrDateTimeSchema = z
  .string()
  .refine((value) => dateSchema.safeParse(value).success || dateTimeSchema.safeParse(value).success, {
    message: 'Date must be YYYY-MM-DD or an RFC 3339 date-time with timezone',
  });

/**
 * Extracts a leading numeric ID from an autocomplete label such as `"42 (Checking - asset)"`.
 *
 * This relies on the completion-label format (the numeric ID always comes first). When the value
 * has no leading digits it is returned unchanged. Note that a free-typed value like `"42 Main St"`
 * would resolve to `"42"`, so callers should prefer values picked from autocomplete suggestions
 * rather than arbitrary user input.
 */
export function parseId(id: string): string {
  const match = id.match(/^(\d+)/);
  return match ? match[1] : id;
}

// Autocomplete tuning shared by every completion handler.
export const AUTOCOMPLETE_FETCH_LIMIT = 1000; // max records pulled from the API per refresh
export const AUTOCOMPLETE_MAX_SUGGESTIONS = 100; // max labels returned to the client per keystroke
const AUTOCOMPLETE_CACHE_TTL_MS = 60_000; // 1 minute

interface CacheEntry<T> {
  promise: Promise<T>;
  fetchedAt: number;
}

export interface TtlCache<T> {
  /**
   * Returns the cached promise for `key` if it is still fresh, otherwise runs `fetchFn`, caches the
   * resulting promise, and returns it. Promise-level caching collapses the burst of concurrent
   * requests that autocomplete fires during rapid typing into a single fetch. A rejected promise is
   * evicted so the next call retries instead of replaying a cached failure.
   */
  get(key: string, fetchFn: () => Promise<T>): Promise<T>;
  /** Drops all cached entries. */
  clear(): void;
}

/**
 * Creates a module-scoped TTL cache keyed by an opaque identity string. The key MUST scope entries
 * per authenticated user (e.g. a hash of the bearer token): in HTTP mode a single client instance
 * serves every request, so an unkeyed cache would leak one user's data to another.
 */
export function createTtlCache<T>(ttlMs = AUTOCOMPLETE_CACHE_TTL_MS): TtlCache<T> {
  const entries = new Map<string, CacheEntry<T>>();
  return {
    get(key: string, fetchFn: () => Promise<T>): Promise<T> {
      const now = Date.now();
      const existing = entries.get(key);
      if (existing && now - existing.fetchedAt <= ttlMs) return existing.promise;
      const promise = fetchFn().catch((err) => {
        // Evict the failed promise so a later attempt re-fetches rather than caching the rejection.
        if (entries.get(key)?.promise === promise) entries.delete(key);
        throw err;
      });
      entries.set(key, { promise, fetchedAt: now });
      return promise;
    },
    clear(): void {
      entries.clear();
    },
  };
}

/**
 * Ceiling on a single tool response, in characters of emitted text. Roughly 25 000 tokens — large
 * enough that a normal page never approaches it, small enough that one runaway call cannot swallow a
 * conversation's context.
 */
export const MAX_RESPONSE_CHARS = 100_000;

/** Room for the pagination object, the truncation notice and the enclosing braces. */
const ENVELOPE_RESERVE_CHARS = 512;

/** Extra spaces each line of an item gains once nested inside `data: [ … ]` at two-space indent. */
const ITEM_INDENT_OVERHEAD = 4;

export interface TruncationNotice {
  returned: number;
  omitted: number;
  reason: 'response_size_limit';
  hint: string;
}

/**
 * Caps a list response, replacing the tail with a structured notice.
 *
 * Two decisions worth stating.
 *
 * The notice is a property, not a sentence appended to the data. A truncated result that does not
 * announce itself is worse than an error: the model concludes on partial data believing it has all of
 * it. Announcing it in prose inside the payload would be missable and unparseable.
 *
 * At least one item always comes back, even when that item alone exceeds the budget. Returning an
 * empty `data` for a non-empty result is a lie, and a worse one than an oversized response — "there
 * is nothing" and "there is too much" lead to opposite conclusions.
 *
 * Size is measured on the text `defineTool` will actually emit, indentation included. Measuring the
 * compact form would under-count by roughly a third and overshoot the budget every time.
 *
 * Call this after projection, never before: guarding first would drop rows that would have fitted
 * once projected, leaving the model with a needlessly partial set.
 */
export function guardResponseSize(result: UnwrappedList): UnwrappedList & { truncated?: TruncationNotice } {
  const budget = MAX_RESPONSE_CHARS - ENVELOPE_RESERVE_CHARS;
  const kept: UnwrappedList['data'] = [];
  let used = 0;

  for (const item of result.data) {
    const serialised = JSON.stringify(item, null, 2);
    const cost = serialised.length + ITEM_INDENT_OVERHEAD * (serialised.split('\n').length + 1);
    // The `kept.length === 0` clause is what guarantees a non-empty result stays non-empty.
    if (used + cost > budget && kept.length > 0) break;
    kept.push(item);
    used += cost;
  }

  if (kept.length === result.data.length) return result;

  const omitted = result.data.length - kept.length;
  return {
    ...result,
    data: kept,
    truncated: {
      returned: kept.length,
      omitted,
      reason: 'response_size_limit',
      hint:
        'Narrow the date range, lower `limit`, request fewer fields with `fields: "compact"`, or use ' +
        'an aggregate tool to get totals over the whole period without transferring the rows.',
    },
  };
}
