/**
 * Currency exchange rates.
 *
 * Firefly III addresses a rate two ways: by its own id, and by the currency pair (optionally with a
 * date). Both are exposed, because they answer different questions — "change this rate" against
 * "what was EUR/USD on the 3rd" — and mapping one onto the other would mean an extra lookup on every
 * call.
 *
 * The upstream `get_exchange_rate` used to call `GET /exchange-rates/by-currencies/{from}/{to}`,
 * which exists for POST only and answers 404 for a read. The read path is `/exchange-rates/{from}/{to}`.
 */

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

const enc = encodeURIComponent;

export async function fetchExchangeRates(
  client: FireflyClient,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  const query: QueryParams = { page: params.page, limit: params.limit };
  return unwrapList(await client.get<JsonApiListResponse>('/exchange-rates', query));
}

export async function fetchExchangeRateById(client: FireflyClient, id: string): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.get<JsonApiSingleResponse>(`/exchange-rates/${enc(id)}`));
}

/** Every rate recorded for a currency pair. */
export async function fetchExchangeRatesForPair(
  client: FireflyClient,
  from: string,
  to: string,
): Promise<UnwrappedList> {
  return unwrapList(await client.get<JsonApiListResponse>(`/exchange-rates/${enc(from)}/${enc(to)}`));
}

/** The rate for a pair on one date. */
export async function fetchExchangeRateOnDate(
  client: FireflyClient,
  from: string,
  to: string,
  date: string,
): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.get<JsonApiSingleResponse>(`/exchange-rates/${enc(from)}/${enc(to)}/${enc(date)}`));
}

export interface ExchangeRateInput {
  from: string;
  to: string;
  date: string;
  rate: string;
}

export async function createExchangeRate(client: FireflyClient, params: ExchangeRateInput): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.post<JsonApiSingleResponse>('/exchange-rates', params));
}

export async function updateExchangeRate(
  client: FireflyClient,
  id: string,
  params: { rate: string; date?: string },
): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.put<JsonApiSingleResponse>(`/exchange-rates/${enc(id)}`, params));
}

export async function updateExchangeRateOnDate(
  client: FireflyClient,
  from: string,
  to: string,
  date: string,
  params: { rate: string },
): Promise<UnwrappedSingle> {
  return unwrapSingle(
    await client.put<JsonApiSingleResponse>(`/exchange-rates/${enc(from)}/${enc(to)}/${enc(date)}`, params),
  );
}

export async function deleteExchangeRate(client: FireflyClient, id: string): Promise<{ deleted: true; id: string }> {
  await client.delete(`/exchange-rates/${enc(id)}`);
  return { deleted: true, id };
}

export async function deleteExchangeRatesForPair(
  client: FireflyClient,
  from: string,
  to: string,
): Promise<{ deleted: true; from: string; to: string }> {
  await client.delete(`/exchange-rates/${enc(from)}/${enc(to)}`);
  return { deleted: true, from, to };
}

export async function deleteExchangeRateOnDate(
  client: FireflyClient,
  from: string,
  to: string,
  date: string,
): Promise<{ deleted: true; from: string; to: string; date: string }> {
  await client.delete(`/exchange-rates/${enc(from)}/${enc(to)}/${enc(date)}`);
  return { deleted: true, from, to, date };
}

export function registerExchangeRateTools(server: McpServer, client: FireflyClient): void {
  const from = z.string().describe('Source currency code, e.g. EUR');
  const to = z.string().describe('Target currency code, e.g. USD');
  const rate = z.string().describe('Rate as a decimal string, e.g. "1.0842"');
  const rateId = z.string().describe('Exchange rate ID — use get_exchange_rates to find valid IDs');

  defineTool(
    server,
    'get_exchange_rates',
    {
      title: 'Get Exchange Rates',
      description: 'List every exchange rate recorded on this instance.',
      inputSchema: {
        page: z.number().int().positive().optional().default(1).describe('Page number'),
        limit: z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    (params) => fetchExchangeRates(client, params as { page?: number; limit?: number }),
  );

  defineTool(
    server,
    'get_exchange_rate_by_id',
    {
      title: 'Get Exchange Rate by ID',
      description: 'Get one exchange rate by its ID.',
      inputSchema: { id: rateId },
      annotations: READ_ANNOTATIONS,
    },
    ({ id }) => fetchExchangeRateById(client, id as string),
  );

  defineTool(
    server,
    'get_exchange_rates_for_pair',
    {
      title: 'Get Exchange Rates for a Currency Pair',
      description: 'List every rate recorded for one currency pair, across all dates.',
      inputSchema: { from, to },
      annotations: READ_ANNOTATIONS,
    },
    ({ from: f, to: t }) => fetchExchangeRatesForPair(client, f as string, t as string),
  );

  defineTool(
    server,
    'get_exchange_rate_on_date',
    {
      title: 'Get Exchange Rate on a Date',
      description: 'Get the rate for a currency pair on one specific date.',
      inputSchema: { from, to, date: dateSchema.describe('Date (YYYY-MM-DD)') },
      annotations: READ_ANNOTATIONS,
    },
    ({ from: f, to: t, date }) => fetchExchangeRateOnDate(client, f as string, t as string, date as string),
  );

  defineTool(
    server,
    'create_exchange_rate',
    {
      title: 'Create Exchange Rate',
      description:
        'Record an exchange rate for a currency pair on a date. Firefly III uses these to convert ' +
        'foreign-currency amounts, so a wrong rate silently changes reported totals.',
      inputSchema: { from, to, date: dateSchema.describe('Date the rate applies to (YYYY-MM-DD)'), rate },
      annotations: WRITE_ANNOTATIONS,
    },
    (params) => createExchangeRate(client, params as unknown as ExchangeRateInput),
  );

  defineTool(
    server,
    'update_exchange_rate',
    {
      title: 'Update Exchange Rate',
      description: 'Update an exchange rate by ID.',
      inputSchema: { id: rateId, rate, date: dateSchema.optional().describe('Date the rate applies to') },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ id, ...params }) => updateExchangeRate(client, id as string, params as { rate: string; date?: string }),
  );

  defineTool(
    server,
    'update_exchange_rate_on_date',
    {
      title: 'Update Exchange Rate on a Date',
      description: 'Update the rate for a currency pair on one date, without needing its ID.',
      inputSchema: { from, to, date: dateSchema.describe('Date (YYYY-MM-DD)'), rate },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ from: f, to: t, date, rate: r }) =>
      updateExchangeRateOnDate(client, f as string, t as string, date as string, { rate: r as string }),
  );

  defineTool(
    server,
    'delete_exchange_rate',
    {
      title: 'Delete Exchange Rate',
      description:
        'Permanently delete one exchange rate by ID. **This action cannot be undone.** Amounts already ' +
        'converted using it are not recalculated.',
      inputSchema: { id: rateId },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ id }) => deleteExchangeRate(client, id as string),
  );

  defineTool(
    server,
    'delete_exchange_rates_for_pair',
    {
      title: 'Delete All Exchange Rates for a Pair',
      description:
        'Permanently delete **every** rate recorded for a currency pair, across all dates. ' +
        '**This action cannot be undone.** Use delete_exchange_rate_on_date to remove just one.',
      inputSchema: { from, to },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ from: f, to: t }) => deleteExchangeRatesForPair(client, f as string, t as string),
  );

  defineTool(
    server,
    'delete_exchange_rate_on_date',
    {
      title: 'Delete Exchange Rate on a Date',
      description: 'Permanently delete the rate for a currency pair on one date. **This action cannot be undone.**',
      inputSchema: { from, to, date: dateSchema.describe('Date (YYYY-MM-DD)') },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ from: f, to: t, date }) => deleteExchangeRateOnDate(client, f as string, t as string, date as string),
  );
}
