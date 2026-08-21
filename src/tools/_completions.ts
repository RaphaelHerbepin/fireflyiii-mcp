/**
 * MCP argument completions, served by Firefly III's own autocomplete endpoints.
 *
 * What this replaces: each of the three completable parameters used to fetch up to a thousand records
 * and filter them in memory, on every keystroke. That is a large response to obtain a handful of
 * labels, it silently truncates on an instance with more than a thousand accounts, and the matching
 * rule was whatever `includes()` does rather than whatever Firefly does.
 *
 * The endpoints take a `query` and a `limit`, so the filtering happens where the data is.
 *
 * Two properties are preserved deliberately:
 *
 *  - **Promise-level caching.** Typing fires a completion per keystroke; caching the promise collapses
 *    a burst into one request. The cache key now includes the query, since results depend on it.
 *  - **Label format `"<id> (<name>)"`.** `parseId` reads the leading id back out, and every tool that
 *    accepts a completable value depends on that shape.
 *
 * A 404 falls back to the old listing path, so the server keeps working against Firefly versions
 * predating these endpoints.
 */

import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { z } from 'zod';
import type { FireflyClient } from '../client.js';
import { debugLog } from '../debug.js';
import type { UnwrappedList } from '../transform.js';
import { AUTOCOMPLETE_MAX_SUGGESTIONS, createTtlCache } from './_helpers.js';
import { type AutocompleteEntityType, fetchAutocomplete, toSuggestions } from './search.js';

/** Cached per identity *and* per query: unlike the old whole-list cache, results depend on the term. */
interface CachedSuggestions {
  suggestions: Array<{ id: string; label: string }>;
  /** True when Firefly already applied the query, so no local filtering should be repeated. */
  filtered: boolean;
}

const completionCache = createTtlCache<CachedSuggestions>();

export function clearCompletionCache(): void {
  completionCache.clear();
}

export interface CompletionFallback {
  /** Called when the autocomplete endpoint is unavailable. Should return the full list to filter. */
  list: () => Promise<UnwrappedList>;
  /**
   * The label for a listing row — the display part only, not the whole `"<id> (<label>)"` line.
   * Formatting happens in one place so endpoint and fallback suggestions are indistinguishable.
   */
  label: (item: Record<string, unknown>) => string;
}

/**
 * Wraps a Zod schema with completions drawn from an autocomplete endpoint.
 *
 * Completion handlers must never throw: a failed completion should degrade to no suggestions, not
 * break the tool call that carries it.
 */
export function withEntityCompletion(
  schema: z.ZodString,
  client: FireflyClient,
  entity: AutocompleteEntityType,
  fallback?: CompletionFallback,
): z.ZodString {
  return completable(schema, async (raw) => {
    const value = String(raw ?? '');
    const key = `${client.cacheKey()}:${entity}:${value.toLowerCase()}`;
    try {
      const { suggestions, filtered } = await completionCache.get(key, async () => {
        try {
          const rows = await fetchAutocomplete(client, entity, {
            query: value || undefined,
            limit: AUTOCOMPLETE_MAX_SUGGESTIONS,
          });
          // Already filtered by Firefly, and filtering again locally would be worse than redundant:
          // the endpoint matches fields the label does not show — an account found by IBAN or account
          // number has neither in its label, so a second pass would discard a correct hit.
          return {
            suggestions: toSuggestions(entity, rows).map((row) => ({ id: row.id, label: row.label })),
            filtered: true,
          };
        } catch (err) {
          if (!fallback) throw err;
          // Older instances have no /autocomplete/* endpoints. Filtering a full listing is worse, but
          // far better than an autocomplete that silently stops working after an upgrade boundary.
          debugLog(`[Completion] ${entity} endpoint unavailable, falling back to listing:`, err);
          const listing = await fallback.list();
          return {
            suggestions: listing.data.map((item) => ({ id: String(item.id), label: fallback.label(item) })),
            filtered: false,
          };
        }
      });

      const needle = value.toLowerCase();
      return suggestions
        .map((row) => `${row.id} (${row.label})`)
        .filter((label) => filtered || label.toLowerCase().includes(needle))
        .slice(0, AUTOCOMPLETE_MAX_SUGGESTIONS);
    } catch (err) {
      debugLog(`[Completion Error - ${entity}]:`, err);
      return [];
    }
  }) as unknown as z.ZodString;
}
