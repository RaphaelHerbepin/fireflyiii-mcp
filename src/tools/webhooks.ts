/**
 * Webhooks: Firefly III calling out to a URL you choose when something happens.
 *
 * Two things about this surface are worth knowing before using it.
 *
 * **It is disabled by default.** Every route here answers 404 — `GET /webhooks` included — until the
 * `configuration.allow_webhooks` setting is switched on by a user with the owner role. A 404 that
 * means "switched off" rather than "does not exist" is easy to misread, so `formatError` is not enough
 * on its own: the tool descriptions say so, and so does the error these tools surface.
 *
 * **The spec is wrong about the payload.** `WebhookStore.required` lists `trigger`, `response` and
 * `delivery`; the properties are `triggers`, `responses` and `deliveries`. A live 6.5.5 instance
 * rejects the singular form outright — "You must not submit anything in field" — and requires the
 * plural arrays, which is what these tools send.
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
import { defineTool } from './_helpers.js';

/** Events a webhook can fire on. */
export const WEBHOOK_TRIGGERS = [
  'STORE_TRANSACTION',
  'UPDATE_TRANSACTION',
  'DESTROY_TRANSACTION',
  'STORE_BUDGET',
  'UPDATE_BUDGET',
  'DESTROY_BUDGET',
] as const;

/** What the webhook body contains. */
export const WEBHOOK_RESPONSES = ['TRANSACTIONS', 'ACCOUNTS', 'NONE'] as const;

/** How the body is delivered. */
export const WEBHOOK_DELIVERIES = ['JSON'] as const;

const pagination = (params: { page?: number; limit?: number }): QueryParams => ({
  page: params.page,
  limit: params.limit,
});

export async function fetchWebhooks(
  client: FireflyClient,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  return unwrapList(await client.get<JsonApiListResponse>('/webhooks', pagination(params)));
}

export async function fetchWebhook(client: FireflyClient, id: string): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.get<JsonApiSingleResponse>(`/webhooks/${id}`));
}

export interface WebhookInput {
  title: string;
  url: string;
  triggers: string[];
  responses: string[];
  deliveries?: string[];
  active?: boolean;
}

export async function createWebhook(client: FireflyClient, params: WebhookInput): Promise<UnwrappedSingle> {
  return unwrapSingle(
    await client.post<JsonApiSingleResponse>('/webhooks', {
      ...params,
      // Plural, despite what the spec's `required` block says. Verified against 6.5.5.
      deliveries: params.deliveries ?? ['JSON'],
    }),
  );
}

/**
 * Replaces a webhook.
 *
 * Firefly III treats this PUT as a replace rather than a patch: `triggers`, `responses` and
 * `deliveries` are all rejected as missing if omitted, even when the caller only meant to flip
 * `active`. The tool schema requires them for that reason — a schema that accepted their absence
 * would produce a 422 the caller had no way to anticipate.
 */
export async function updateWebhook(
  client: FireflyClient,
  id: string,
  params: Partial<WebhookInput> & Pick<Required<WebhookInput>, 'triggers' | 'responses' | 'deliveries'>,
): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.put<JsonApiSingleResponse>(`/webhooks/${id}`, params));
}

export async function deleteWebhook(client: FireflyClient, id: string): Promise<{ deleted: true; id: string }> {
  await client.delete(`/webhooks/${id}`);
  return { deleted: true, id };
}

/** Queued or delivered messages for one webhook — where you look when a webhook is not arriving. */
export async function fetchWebhookMessages(
  client: FireflyClient,
  id: string,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  return unwrapList(await client.get<JsonApiListResponse>(`/webhooks/${id}/messages`, pagination(params)));
}

export async function fetchWebhookMessage(
  client: FireflyClient,
  id: string,
  messageId: string,
): Promise<UnwrappedSingle> {
  return unwrapSingle(await client.get<JsonApiSingleResponse>(`/webhooks/${id}/messages/${messageId}`));
}

export async function deleteWebhookMessage(
  client: FireflyClient,
  id: string,
  messageId: string,
): Promise<{ deleted: true; id: string }> {
  await client.delete(`/webhooks/${id}/messages/${messageId}`);
  return { deleted: true, id: messageId };
}

/** Delivery attempts for one message, with whatever the remote end answered. */
export async function fetchWebhookMessageAttempts(
  client: FireflyClient,
  id: string,
  messageId: string,
  params: { page?: number; limit?: number },
): Promise<UnwrappedList> {
  return unwrapList(
    await client.get<JsonApiListResponse>(`/webhooks/${id}/messages/${messageId}/attempts`, pagination(params)),
  );
}

export async function fetchWebhookMessageAttempt(
  client: FireflyClient,
  id: string,
  messageId: string,
  attemptId: string,
): Promise<UnwrappedSingle> {
  return unwrapSingle(
    await client.get<JsonApiSingleResponse>(`/webhooks/${id}/messages/${messageId}/attempts/${attemptId}`),
  );
}

export async function deleteWebhookMessageAttempt(
  client: FireflyClient,
  id: string,
  messageId: string,
  attemptId: string,
): Promise<{ deleted: true; id: string }> {
  await client.delete(`/webhooks/${id}/messages/${messageId}/attempts/${attemptId}`);
  return { deleted: true, id: attemptId };
}

/** Sends every queued message for a webhook. */
export async function submitWebhook(client: FireflyClient, id: string): Promise<{ submitted: true; id: string }> {
  await client.post(`/webhooks/${id}/submit`, {});
  return { submitted: true, id };
}

/** Replays one transaction through a webhook, without waiting for the event to happen again. */
export async function triggerTransactionWebhook(
  client: FireflyClient,
  id: string,
  transactionId: string,
): Promise<{ triggered: true; id: string; transaction_id: string }> {
  await client.post(`/webhooks/${id}/trigger-transaction/${transactionId}`, {});
  return { triggered: true, id, transaction_id: transactionId };
}

const DISABLED_HINT =
  ' If this returns "Resource not found", webhooks are switched off on the instance rather than ' +
  'missing: a user with the owner role must set configuration.allow_webhooks to true.';

export function registerWebhookTools(server: McpServer, client: FireflyClient): void {
  const webhookId = z.string().describe('Webhook ID — use get_webhooks to find valid IDs');
  const messageId = z.string().describe('Webhook message ID — use get_webhook_messages to find valid IDs');
  const page = z.number().int().positive().optional().default(1).describe('Page number');
  const limit = z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)');

  defineTool(
    server,
    'get_webhooks',
    {
      title: 'Get Webhooks',
      description: `List the webhooks configured on this Firefly III instance.${DISABLED_HINT}`,
      inputSchema: { page, limit },
      annotations: READ_ANNOTATIONS,
    },
    (params) => fetchWebhooks(client, params as { page?: number; limit?: number }),
  );

  defineTool(
    server,
    'get_webhook',
    {
      title: 'Get Webhook',
      description: 'Get one webhook by ID, including its triggers, response type and secret.',
      inputSchema: { id: webhookId },
      annotations: READ_ANNOTATIONS,
    },
    ({ id }) => fetchWebhook(client, id as string),
  );

  defineTool(
    server,
    'create_webhook',
    {
      title: 'Create Webhook',
      description:
        'Create a webhook. **The URL you give will receive your transaction data** from this Firefly III ' +
        'instance every time a matching event occurs — only point it at an endpoint you control and ' +
        `trust. Firefly III checks that the URL resolves before accepting it.${DISABLED_HINT}`,
      inputSchema: {
        title: z.string().describe('A name for this webhook'),
        url: z.string().url().describe('Where to POST the payload. Must be resolvable.'),
        triggers: z.array(z.enum(WEBHOOK_TRIGGERS)).min(1).describe('Events that fire this webhook'),
        responses: z.array(z.enum(WEBHOOK_RESPONSES)).min(1).describe('What the payload contains'),
        deliveries: z.array(z.enum(WEBHOOK_DELIVERIES)).optional().describe('Delivery format. Defaults to JSON.'),
        active: z.boolean().optional().describe('Whether the webhook fires. Defaults to true.'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (params) => createWebhook(client, params as unknown as WebhookInput),
  );

  defineTool(
    server,
    'update_webhook',
    {
      title: 'Update Webhook',
      description:
        'Update a webhook. Firefly III replaces the whole record rather than patching it, so `triggers` ' +
        '`responses` and `deliveries` must all be supplied even when only toggling `active` — call ' +
        'get_webhook first and ' +
        'pass its values back. Changing the URL redirects your transaction data to a new destination.',
      inputSchema: {
        id: webhookId,
        // Required by the API even on a partial-looking update: PUT here is a replace, not a patch.
        // Making them optional in the schema would produce a 422 the caller could not have predicted.
        triggers: z.array(z.enum(WEBHOOK_TRIGGERS)).min(1).describe('Events that fire this webhook (required)'),
        responses: z.array(z.enum(WEBHOOK_RESPONSES)).min(1).describe('What the payload contains (required)'),
        deliveries: z
          .array(z.enum(WEBHOOK_DELIVERIES))
          .min(1)
          .optional()
          .default(['JSON'])
          .describe('Delivery format (required by the API; defaults to JSON)'),
        title: z.string().optional().describe('A name for this webhook'),
        url: z.string().url().optional().describe('Where to POST the payload'),
        active: z.boolean().optional().describe('Whether the webhook fires'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ id, ...params }) => updateWebhook(client, id as string, params as Parameters<typeof updateWebhook>[2]),
  );

  defineTool(
    server,
    'delete_webhook',
    {
      title: 'Delete Webhook',
      description:
        'Permanently delete a webhook and its message history. **This action cannot be undone.** ' +
        'Use update_webhook with active: false to stop it firing without losing it.',
      inputSchema: { id: webhookId },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ id }) => deleteWebhook(client, id as string),
  );

  defineTool(
    server,
    'get_webhook_messages',
    {
      title: 'Get Webhook Messages',
      description:
        'List the messages a webhook has queued or sent. This is where to look when a webhook is not ' +
        'arriving: a message exists per event, and each has its own delivery attempts.',
      inputSchema: { id: webhookId, page, limit },
      annotations: READ_ANNOTATIONS,
    },
    ({ id, page: p, limit: l }) =>
      fetchWebhookMessages(client, id as string, { page: p as number | undefined, limit: l as number | undefined }),
  );

  defineTool(
    server,
    'get_webhook_message',
    {
      title: 'Get Webhook Message',
      description: 'Get one webhook message, including the payload that was or will be sent.',
      inputSchema: { id: webhookId, messageId },
      annotations: READ_ANNOTATIONS,
    },
    ({ id, messageId: m }) => fetchWebhookMessage(client, id as string, m as string),
  );

  defineTool(
    server,
    'delete_webhook_message',
    {
      title: 'Delete Webhook Message',
      description:
        'Permanently delete a webhook message and its attempts. **This action cannot be undone.** ' +
        'Useful to clear a message that keeps failing.',
      inputSchema: { id: webhookId, messageId },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ id, messageId: m }) => deleteWebhookMessage(client, id as string, m as string),
  );

  defineTool(
    server,
    'get_webhook_message_attempts',
    {
      title: 'Get Webhook Message Attempts',
      description:
        'List the delivery attempts for one webhook message, with the status and response each got. ' +
        'This is the detail behind "the webhook is not working".',
      inputSchema: { id: webhookId, messageId, page, limit },
      annotations: READ_ANNOTATIONS,
    },
    ({ id, messageId: m, page: p, limit: l }) =>
      fetchWebhookMessageAttempts(client, id as string, m as string, {
        page: p as number | undefined,
        limit: l as number | undefined,
      }),
  );

  defineTool(
    server,
    'get_webhook_message_attempt',
    {
      title: 'Get Webhook Message Attempt',
      description: 'Get one delivery attempt, including the response the remote endpoint returned.',
      inputSchema: {
        id: webhookId,
        messageId,
        attemptId: z.string().describe('Attempt ID — use get_webhook_message_attempts to find valid IDs'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ id, messageId: m, attemptId: a }) => fetchWebhookMessageAttempt(client, id as string, m as string, a as string),
  );

  defineTool(
    server,
    'delete_webhook_message_attempt',
    {
      title: 'Delete Webhook Message Attempt',
      description: 'Permanently delete one delivery attempt record. **This action cannot be undone.**',
      inputSchema: {
        id: webhookId,
        messageId,
        attemptId: z.string().describe('Attempt ID — use get_webhook_message_attempts to find valid IDs'),
      },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ id, messageId: m, attemptId: a }) => deleteWebhookMessageAttempt(client, id as string, m as string, a as string),
  );

  defineTool(
    server,
    'submit_webhook',
    {
      title: 'Submit Webhook',
      description:
        'Send every message this webhook has queued. **Data leaves your instance for the webhook URL.** ' +
        'Normally Firefly III does this on its own schedule; use this to flush the queue now.',
      inputSchema: { id: webhookId },
      annotations: WRITE_ANNOTATIONS,
    },
    ({ id }) => submitWebhook(client, id as string),
  );

  defineTool(
    server,
    'trigger_transaction_webhook',
    {
      title: 'Trigger Webhook for a Transaction',
      description:
        'Replay one transaction through a webhook without waiting for the event to happen again. ' +
        '**The transaction data is sent to the webhook URL.** Useful for testing a webhook against a ' +
        'known transaction.',
      inputSchema: {
        id: webhookId,
        transactionId: z.string().describe('Transaction ID — use get_transactions to find valid IDs'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    ({ id, transactionId }) => triggerTransactionWebhook(client, id as string, transactionId as string),
  );
}
