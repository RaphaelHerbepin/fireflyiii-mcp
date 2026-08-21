import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FireflyClient } from '../client.js';
import {
  type JsonApiListResponse,
  type JsonApiSingleResponse,
  type UnwrappedList,
  type UnwrappedSingle,
  unwrapList,
  unwrapSingle,
} from '../transform.js';
import type { QueryParams } from '../types.js';
import { DELETE_ANNOTATIONS, READ_ANNOTATIONS, UPDATE_ANNOTATIONS, WRITE_ANNOTATIONS } from './_annotations.js';
import { dateSchema, defineTool } from './_helpers.js';

export async function fetchCurrencies(
  client: FireflyClient,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  const response = await client.get<JsonApiListResponse>('/currencies', { page: params.page, limit: params.limit });
  return unwrapList(response);
}

export async function fetchCurrency(client: FireflyClient, code: string): Promise<UnwrappedSingle> {
  const response = await client.get<JsonApiSingleResponse>(`/currencies/${encodeURIComponent(code)}`);
  return unwrapSingle(response);
}

export async function createCurrency(
  client: FireflyClient,
  params: { name: string; code: string; symbol: string; decimal_places?: number; enabled?: boolean; default?: boolean },
): Promise<UnwrappedSingle> {
  const response = await client.post<JsonApiSingleResponse>('/currencies', params);
  return unwrapSingle(response);
}

export async function updateCurrency(
  client: FireflyClient,
  code: string,
  params: { name?: string; symbol?: string; decimal_places?: number; enabled?: boolean; default?: boolean },
): Promise<UnwrappedSingle> {
  const response = await client.put<JsonApiSingleResponse>(`/currencies/${encodeURIComponent(code)}`, params);
  return unwrapSingle(response);
}

export async function deleteCurrency(client: FireflyClient, code: string): Promise<{ deleted: true; code: string }> {
  await client.delete(`/currencies/${encodeURIComponent(code)}`);
  return { deleted: true, code };
}

export async function enableCurrency(client: FireflyClient, code: string): Promise<UnwrappedSingle> {
  const response = await client.post<JsonApiSingleResponse>(`/currencies/${encodeURIComponent(code)}/enable`, {});
  return unwrapSingle(response);
}

export async function disableCurrency(client: FireflyClient, code: string): Promise<UnwrappedSingle> {
  const response = await client.post<JsonApiSingleResponse>(`/currencies/${encodeURIComponent(code)}/disable`, {});
  return unwrapSingle(response);
}

export async function setPrimaryCurrency(client: FireflyClient, code: string): Promise<UnwrappedSingle> {
  const response = await client.post<JsonApiSingleResponse>(`/currencies/${encodeURIComponent(code)}/primary`, {});
  return unwrapSingle(response);
}

/** The administration's primary currency — the one totals are reported in. */
export async function fetchPrimaryCurrency(client: FireflyClient): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.get<JsonApiSingleResponse>('/currencies/primary'));
}

/**
 * Sub-resources reachable under a currency.
 *
 * Exported so scripts/check-api-coverage.ts can expand them: fetchCurrencyRelated takes the resource
 * as a parameter, so static analysis sees a variable rather than seven routes.
 */
export const CURRENCY_SUBRESOURCES = [
  'accounts',
  'available-budgets',
  'bills',
  'budget-limits',
  'recurrences',
  'rules',
  'transactions',
] as const;

export type CurrencySubresource = (typeof CURRENCY_SUBRESOURCES)[number];

/**
 * Records of one kind denominated in a given currency.
 *
 * One parameterised tool rather than seven. Multi-currency is a corner case for most instances, and
 * seven permanent tool definitions to serve it is a poor trade against the context they occupy. If
 * that ever stops being true, splitting this back out is mechanical.
 */
export async function fetchCurrencyRelated(
  client: FireflyClient,
  code: string,
  resource: CurrencySubresource,
  params: { start?: string; end?: string; page?: number; limit?: number },
): Promise<UnwrappedList> {
  const query: QueryParams = { page: params.page, limit: params.limit };
  if (params.start) query.start = params.start;
  if (params.end) query.end = params.end;
  return unwrapList(
    await client.get<JsonApiListResponse>(`/currencies/${encodeURIComponent(code)}/${resource}`, query),
  );
}

export function registerCurrencyTools(server: McpServer, client: FireflyClient): void {
  defineTool(
    server,
    'get_currencies',
    {
      title: 'Get Currencies',
      description: 'Get all currencies configured in Firefly III.',
      inputSchema: {
        page: z.number().int().positive().optional().default(1).describe('Page number'),
        limit: z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ page, limit }) =>
      fetchCurrencies(client, { page: page as number | undefined, limit: limit as number | undefined }),
  );

  defineTool(
    server,
    'get_currency',
    {
      title: 'Get Currency',
      description: 'Get a single currency by its currency code (e.g. EUR, USD).',
      inputSchema: { code: z.string().describe('Currency code (e.g. EUR, USD)') },
      annotations: READ_ANNOTATIONS,
    },
    ({ code }) => fetchCurrency(client, code as string),
  );

  defineTool(
    server,
    'get_primary_currency',
    {
      title: 'Get Primary Currency',
      description:
        "Get the administration's primary currency — the one Firefly III reports totals in. Worth " +
        'checking before interpreting any figure on a multi-currency instance.',
      inputSchema: {},
      annotations: READ_ANNOTATIONS,
    },
    () => fetchPrimaryCurrency(client),
  );

  defineTool(
    server,
    'get_currency_related',
    {
      title: 'Get Records in a Currency',
      description:
        'List the accounts, bills, budget limits, recurrences, rules, available budgets or transactions ' +
        'denominated in one currency. Useful on a multi-currency instance to see what a currency ' +
        'actually touches before enabling, disabling or deleting it. Note: `available-budgets` returns ' +
        'a server error on Firefly III 6.5.5 — that is an upstream defect, not a bad request.',
      inputSchema: {
        code: z.string().describe('Currency code, e.g. EUR'),
        resource: z.enum(CURRENCY_SUBRESOURCES).describe('Which kind of record to list'),
        start: dateSchema.optional().describe('Start date, for transactions and budget limits'),
        end: dateSchema.optional().describe('End date, for transactions and budget limits'),
        page: z.number().int().positive().optional().default(1).describe('Page number'),
        limit: z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ code, resource, start, end, page, limit }) =>
      fetchCurrencyRelated(client, code as string, resource as CurrencySubresource, {
        start: start as string | undefined,
        end: end as string | undefined,
        page: page as number | undefined,
        limit: limit as number | undefined,
      }),
  );

  defineTool(
    server,
    'create_currency',
    {
      title: 'Create Currency',
      description: 'Create a new currency in Firefly III.',
      inputSchema: {
        name: z.string().describe('Currency name (e.g. Euro)'),
        code: z.string().describe('Currency code (e.g. EUR)'),
        symbol: z.string().describe('Currency symbol (e.g. €)'),
        decimal_places: z.number().int().min(0).max(10).optional().describe('Number of decimal places (default 2)'),
        enabled: z.boolean().optional().describe('Whether the currency is enabled'),
        default: z.boolean().optional().describe('Whether this is the default currency'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (params) => createCurrency(client, params as Parameters<typeof createCurrency>[1]),
  );

  defineTool(
    server,
    'update_currency',
    {
      title: 'Update Currency',
      description:
        'Update an existing currency. Only fields provided will be changed. Use get_currencies to find valid currency codes.',
      inputSchema: {
        code: z.string().describe('Currency code to update (e.g. EUR)'),
        name: z.string().optional().describe('Currency name'),
        symbol: z.string().optional().describe('Currency symbol'),
        decimal_places: z.number().int().min(0).max(10).optional().describe('Number of decimal places'),
        enabled: z.boolean().optional().describe('Whether the currency is enabled'),
        default: z.boolean().optional().describe('Whether this is the default currency'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ code, ...params }) => updateCurrency(client, code as string, params as Parameters<typeof updateCurrency>[2]),
  );

  defineTool(
    server,
    'delete_currency',
    {
      title: 'Delete Currency',
      description:
        'Permanently delete a currency from Firefly III. **This action cannot be undone.** Use get_currencies to confirm the code before deleting.',
      inputSchema: { code: z.string().describe('Currency code to delete (e.g. EUR)') },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ code }) => deleteCurrency(client, code as string),
  );

  defineTool(
    server,
    'enable_currency',
    {
      title: 'Enable Currency',
      description: 'Enable a currency so it can be used in transactions.',
      inputSchema: { code: z.string().describe('Currency code (e.g. EUR)') },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ code }) => enableCurrency(client, code as string),
  );

  defineTool(
    server,
    'disable_currency',
    {
      title: 'Disable Currency',
      description: 'Disable a currency so it no longer appears in transaction forms.',
      inputSchema: { code: z.string().describe('Currency code (e.g. EUR)') },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ code }) => disableCurrency(client, code as string),
  );

  defineTool(
    server,
    'set_primary_currency',
    {
      title: 'Set Primary Currency',
      description: 'Set a currency as the primary/default currency for Firefly III.',
      inputSchema: { code: z.string().describe('Currency code to set as primary (e.g. EUR)') },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ code }) => setPrimaryCurrency(client, code as string),
  );
}
