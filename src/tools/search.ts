/**
 * One search tool over Firefly III's seventeen `/autocomplete/*` endpoints.
 *
 * Exposing them as seventeen tools would cost seventeen tool definitions in every `tools/list`
 * response, permanently, to answer a question nobody asks directly — "what are the autocomplete
 * entries for tags?" is a means, not an end. The end is resolving a name to an id, which one
 * parameterised tool does just as well.
 *
 * The larger gain is elsewhere: `_completions.ts` points the existing MCP completions at these
 * endpoints, replacing "fetch a thousand records and filter them in memory on every keystroke" with a
 * server-side query.
 *
 * These endpoints return a **flat array**, not a JSON:API envelope — no `unwrapList` here.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FireflyClient } from '../client.js';
import type { QueryParams } from '../types.js';
import { READ_ANNOTATIONS } from './_annotations.js';
import { dateSchema, defineTool } from './_helpers.js';

export interface AutocompleteEntity {
  readonly path: string;
  /** Field holding the human-readable label. */
  readonly labelField: string;
  /** Accounts alone accept a balance date and a type filter. */
  readonly supportsDate?: true;
  readonly supportsTypes?: true;
}

/**
 * The seventeen autocomplete endpoints.
 *
 * Exported so `scripts/check-api-coverage.ts` can expand them: `fetchAutocomplete` takes its path from
 * this table, so static analysis sees a variable and — correctly — refuses to guess.
 */
export const AUTOCOMPLETE_ENTITIES = {
  accounts: {
    path: '/autocomplete/accounts',
    labelField: 'name_with_balance',
    supportsDate: true,
    supportsTypes: true,
  },
  bills: { path: '/autocomplete/bills', labelField: 'name' },
  budgets: { path: '/autocomplete/budgets', labelField: 'name' },
  categories: { path: '/autocomplete/categories', labelField: 'name' },
  currencies: { path: '/autocomplete/currencies', labelField: 'name' },
  'currencies-with-code': { path: '/autocomplete/currencies-with-code', labelField: 'name' },
  'object-groups': { path: '/autocomplete/object-groups', labelField: 'title' },
  'piggy-banks': { path: '/autocomplete/piggy-banks', labelField: 'name' },
  'piggy-banks-with-balance': { path: '/autocomplete/piggy-banks-with-balance', labelField: 'name_with_balance' },
  recurring: { path: '/autocomplete/recurring', labelField: 'name' },
  'rule-groups': { path: '/autocomplete/rule-groups', labelField: 'name' },
  rules: { path: '/autocomplete/rules', labelField: 'name' },
  subscriptions: { path: '/autocomplete/subscriptions', labelField: 'name' },
  tags: { path: '/autocomplete/tags', labelField: 'tag' },
  'transaction-types': { path: '/autocomplete/transaction-types', labelField: 'name' },
  transactions: { path: '/autocomplete/transactions', labelField: 'description' },
  'transactions-with-id': { path: '/autocomplete/transactions-with-id', labelField: 'description' },
} as const satisfies Record<string, AutocompleteEntity>;

export type AutocompleteEntityType = keyof typeof AUTOCOMPLETE_ENTITIES;

export const AUTOCOMPLETE_ENTITY_NAMES = Object.keys(AUTOCOMPLETE_ENTITIES) as [
  AutocompleteEntityType,
  ...AutocompleteEntityType[],
];

/** Raw autocomplete rows. Flat array, no JSON:API envelope. */
export async function fetchAutocomplete(
  client: FireflyClient,
  entity: AutocompleteEntityType,
  params: { query?: string; limit?: number; date?: string; types?: string[] },
): Promise<Array<Record<string, unknown>>> {
  const definition = AUTOCOMPLETE_ENTITIES[entity];
  const search: QueryParams = {};
  if (params.query) search.query = params.query;
  if (params.limit) search.limit = params.limit;
  if (params.date && 'supportsDate' in definition) search.date = params.date;
  if (params.types && 'supportsTypes' in definition) search.types = params.types;

  const rows = await client.get<Array<Record<string, unknown>>>(definition.path, search);
  return Array.isArray(rows) ? rows : [];
}

/** `{ id, label, …rest }` — the shape both the tool and the completion handlers consume. */
export function toSuggestions(
  entity: AutocompleteEntityType,
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<{ id: string; label: string } & Record<string, unknown>> {
  const { labelField } = AUTOCOMPLETE_ENTITIES[entity];
  return rows.map((row) => {
    const { id, ...rest } = row;
    return {
      id: String(id ?? ''),
      label: String(row[labelField] ?? row.name ?? ''),
      ...rest,
    };
  });
}

export function registerSearchTools(server: McpServer, client: FireflyClient): void {
  defineTool(
    server,
    'search_entities',
    {
      title: 'Search Entities',
      description:
        'Resolve a name to an ID. Searches accounts, budgets, categories, bills, tags, piggy banks, ' +
        'rules, currencies and more by substring, and returns matching IDs with their labels. Use this ' +
        'before any tool that takes an ID, rather than listing everything and scanning it: it is one ' +
        'small request instead of a full listing.',
      inputSchema: {
        entity_type: z.enum(AUTOCOMPLETE_ENTITY_NAMES).describe('What to search'),
        query: z
          .string()
          .optional()
          .describe('Substring to match, case-insensitive. Omit to get the first `limit` entries.'),
        limit: z.number().int().positive().max(100).optional().default(25).describe('Maximum results'),
        date: dateSchema.optional().describe('accounts only — report balances as at this date'),
        types: z
          .array(z.string())
          .optional()
          .describe('accounts only — restrict to these account types, e.g. ["asset"]'),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ entity_type, query, limit, date, types }) => {
      const entity = entity_type as AutocompleteEntityType;
      const rows = await fetchAutocomplete(client, entity, {
        query: query as string | undefined,
        limit: limit as number | undefined,
        date: date as string | undefined,
        types: types as string[] | undefined,
      });
      return { entity_type: entity, count: rows.length, results: toSuggestions(entity, rows) };
    },
  );
}
