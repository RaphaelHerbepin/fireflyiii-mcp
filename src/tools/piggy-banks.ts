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

export async function fetchPiggyBanks(
  client: FireflyClient,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  const response = await client.get<JsonApiListResponse>('/piggy-banks', { page: params.page, limit: params.limit });
  return unwrapList(response);
}

/**
 * Creates a piggy bank.
 *
 * Firefly III 6.5.5 requires an `accounts` array and a currency; sending the older single
 * `account_id` is rejected with 422. The spec is self-contradictory here — it lists `account_id`
 * under `required` while never declaring it as a property — so this was settled against a live
 * instance (see src/tests/phantom-routes.test.ts). The tool keeps taking one account id, which is
 * what callers actually have, and builds the array here.
 */
export async function createPiggyBank(
  client: FireflyClient,
  params: {
    name: string;
    account_id: string;
    target_amount?: string;
    start_date?: string;
    target_date?: string;
    notes?: string;
    currency_code?: string;
    object_group_title?: string;
  },
): Promise<UnwrappedSingle> {
  const { account_id, currency_code, ...rest } = params;
  const response = await client.post<JsonApiSingleResponse>('/piggy-banks', {
    ...rest,
    accounts: [{ account_id }],
    transaction_currency_code: currency_code ?? 'EUR',
  });
  return unwrapSingle(response);
}

export async function updatePiggyBank(
  client: FireflyClient,
  id: string,
  params: {
    name?: string;
    account_id?: string;
    target_amount?: string;
    start_date?: string;
    target_date?: string;
    notes?: string;
  },
): Promise<UnwrappedSingle> {
  const response = await client.put<JsonApiSingleResponse>(`/piggy-banks/${id}`, params);
  return unwrapSingle(response);
}

export async function deletePiggyBank(client: FireflyClient, id: string): Promise<{ deleted: true; id: string }> {
  await client.delete(`/piggy-banks/${id}`);
  return { deleted: true, id };
}

export async function fetchPiggyBankEvents(
  client: FireflyClient,
  id: string,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  const query: QueryParams = { page: params.page, limit: params.limit };
  const response = await client.get<JsonApiListResponse>(`/piggy-banks/${id}/events`, query);
  return unwrapList(response);
}

export function registerPiggyBankTools(server: McpServer, client: FireflyClient): void {
  defineTool(
    server,
    'get_piggy_banks',
    {
      title: 'Get Piggy Banks',
      description:
        'Get all piggy banks (savings goals) from Firefly III, including current saved amount and target amount.',
      inputSchema: {
        page: z.number().int().positive().optional().default(1).describe('Page number'),
        limit: z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ page, limit }) =>
      fetchPiggyBanks(client, { page: page as number | undefined, limit: limit as number | undefined }),
  );

  defineTool(
    server,
    'create_piggy_bank',
    {
      title: 'Create Piggy Bank',
      description: 'Create a new savings goal (piggy bank) in Firefly III. Requires an asset account ID to link to.',
      inputSchema: {
        name: z.string().describe('Piggy bank name'),
        account_id: z.string().describe('Asset account ID to link to — use get_accounts to find valid IDs'),
        currency_code: z
          .string()
          .optional()
          .describe('Currency code (e.g. EUR). Required by the API; defaults to EUR.'),
        object_group_title: z
          .string()
          .optional()
          .describe('Group this piggy bank under a named object group, creating the group if needed'),
        target_amount: z.string().optional().describe('Savings goal amount as a number string'),
        start_date: dateSchema.optional().describe('Start date (YYYY-MM-DD)'),
        target_date: dateSchema.optional().describe('Target completion date (YYYY-MM-DD)'),
        notes: z.string().optional().describe('Notes'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (params) => createPiggyBank(client, params as Parameters<typeof createPiggyBank>[1]),
  );

  defineTool(
    server,
    'update_piggy_bank',
    {
      title: 'Update Piggy Bank',
      description:
        'Update an existing piggy bank in Firefly III. Only fields provided will be changed. Use get_piggy_banks to find valid IDs.',
      inputSchema: {
        id: z.string().describe('Piggy bank ID — use get_piggy_banks to find valid IDs'),
        name: z.string().optional().describe('Piggy bank name'),
        account_id: z.string().optional().describe('Asset account ID to link to'),
        target_amount: z.string().optional().describe('Savings goal amount as a number string'),
        start_date: dateSchema.optional().describe('Start date (YYYY-MM-DD)'),
        target_date: dateSchema.optional().describe('Target completion date (YYYY-MM-DD)'),
        notes: z.string().optional().describe('Notes'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ id, ...params }) => updatePiggyBank(client, id as string, params as Parameters<typeof updatePiggyBank>[2]),
  );

  defineTool(
    server,
    'delete_piggy_bank',
    {
      title: 'Delete Piggy Bank',
      description:
        'Permanently delete a piggy bank (savings goal) from Firefly III. **This action cannot be undone.** Use get_piggy_banks to confirm the ID before deleting.',
      inputSchema: { id: z.string().describe('Piggy bank ID — use get_piggy_banks to find valid IDs') },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ id }) => deletePiggyBank(client, id as string),
  );

  defineTool(
    server,
    'get_piggy_bank_events',
    {
      title: 'Get Piggy Bank Events',
      description:
        'Get all deposit/withdrawal events for a specific piggy bank. Use get_piggy_banks to find valid IDs.',
      inputSchema: {
        id: z.string().describe('Piggy bank ID'),
        page: z.number().int().positive().optional().default(1).describe('Page number'),
        limit: z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ id, page, limit }) =>
      fetchPiggyBankEvents(client, id as string, {
        page: page as number | undefined,
        limit: limit as number | undefined,
      }),
  );
}
