import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  createWebhook,
  deleteWebhook,
  deleteWebhookMessage,
  fetchWebhook,
  fetchWebhookMessageAttempts,
  fetchWebhookMessages,
  fetchWebhooks,
  registerWebhookTools,
  submitWebhook,
  triggerTransactionWebhook,
  updateWebhook,
} from '../tools/webhooks.js';
import { createMockServer } from './_helpers.js';

const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as FireflyClient;

const webhookSingle = {
  data: {
    id: '1',
    type: 'webhooks',
    attributes: {
      title: 'Notify on new transaction',
      url: 'https://example.com/hook',
      triggers: ['STORE_TRANSACTION'],
      responses: ['TRANSACTIONS'],
      deliveries: ['JSON'],
      active: true,
      secret: 'abc123',
    },
    links: {},
  },
};

const webhookList = {
  data: [webhookSingle.data],
  meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
};

describe('fetchWebhooks', () => {
  it('calls /webhooks with pagination', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(webhookList);
    await fetchWebhooks(mockClient, { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/webhooks', { page: 1, limit: 50 });
  });

  it('unwraps the envelope', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(webhookList);
    const result = await fetchWebhooks(mockClient, {});
    expect(result.data[0]).toMatchObject({ id: '1', title: 'Notify on new transaction' });
  });
});

describe('createWebhook', () => {
  it('sends plural triggers, responses and deliveries', async () => {
    // The spec's `required` block names trigger/response/delivery in the singular. A live 6.5.5
    // instance rejects those outright — "You must not submit anything in field" — and requires the
    // plural arrays. Only an instance could settle this.
    mockClient.post = vi.fn().mockResolvedValueOnce(webhookSingle);
    await createWebhook(mockClient, {
      title: 'Notify',
      url: 'https://example.com/hook',
      triggers: ['STORE_TRANSACTION'],
      responses: ['TRANSACTIONS'],
    });
    expect(mockClient.post).toHaveBeenCalledWith('/webhooks', {
      title: 'Notify',
      url: 'https://example.com/hook',
      triggers: ['STORE_TRANSACTION'],
      responses: ['TRANSACTIONS'],
      deliveries: ['JSON'],
    });
  });

  it('passes an explicit delivery format through', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(webhookSingle);
    await createWebhook(mockClient, {
      title: 'Notify',
      url: 'https://example.com/hook',
      triggers: ['STORE_TRANSACTION'],
      responses: ['TRANSACTIONS'],
      deliveries: ['JSON'],
    });
    expect(mockClient.post).toHaveBeenCalledWith('/webhooks', expect.objectContaining({ deliveries: ['JSON'] }));
  });
});

describe('webhook messages and attempts', () => {
  it('reads messages for a webhook', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(webhookList);
    await fetchWebhookMessages(mockClient, '1', { page: 1, limit: 25 });
    expect(mockClient.get).toHaveBeenCalledWith('/webhooks/1/messages', { page: 1, limit: 25 });
  });

  it('reads attempts for a message', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(webhookList);
    await fetchWebhookMessageAttempts(mockClient, '1', '5', {});
    expect(mockClient.get).toHaveBeenCalledWith('/webhooks/1/messages/5/attempts', {
      page: undefined,
      limit: undefined,
    });
  });

  it('deletes a message and confirms with the message id', async () => {
    mockClient.delete = vi.fn().mockResolvedValueOnce(undefined);
    expect(await deleteWebhookMessage(mockClient, '1', '5')).toEqual({ deleted: true, id: '5' });
  });
});

describe('webhook actions', () => {
  it('submits queued messages', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(undefined);
    expect(await submitWebhook(mockClient, '1')).toEqual({ submitted: true, id: '1' });
    expect(mockClient.post).toHaveBeenCalledWith('/webhooks/1/submit', {});
  });

  it('replays one transaction through a webhook', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(undefined);
    expect(await triggerTransactionWebhook(mockClient, '1', '42')).toEqual({
      triggered: true,
      id: '1',
      transaction_id: '42',
    });
    expect(mockClient.post).toHaveBeenCalledWith('/webhooks/1/trigger-transaction/42', {});
  });

  it('updates and deletes', async () => {
    mockClient.put = vi.fn().mockResolvedValueOnce(webhookSingle);
    // triggers and responses are required even here: Firefly's PUT replaces rather than patches.
    // triggers, responses and deliveries are all required even here: Firefly's PUT replaces rather
    // than patches, and omitting any of the three is a 422.
    await updateWebhook(mockClient, '1', {
      active: false,
      triggers: ['STORE_TRANSACTION'],
      responses: ['TRANSACTIONS'],
      deliveries: ['JSON'],
    });
    expect(mockClient.put).toHaveBeenCalledWith('/webhooks/1', {
      active: false,
      triggers: ['STORE_TRANSACTION'],
      responses: ['TRANSACTIONS'],
      deliveries: ['JSON'],
    });

    mockClient.delete = vi.fn().mockResolvedValueOnce(undefined);
    expect(await deleteWebhook(mockClient, '1')).toEqual({ deleted: true, id: '1' });
  });

  it('reads a single webhook', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(webhookSingle);
    expect(await fetchWebhook(mockClient, '1')).toMatchObject({ id: '1', secret: 'abc123' });
  });
});

describe('webhook tool descriptions', () => {
  it('warn that data leaves the instance', () => {
    const { server, toolConfigs } = createMockServer();
    registerWebhookTools(server, mockClient);
    // Creating a webhook points someone else's URL at your financial data; the description has to say
    // so, because the annotation alone does not reach a human reading the tool list.
    expect(toolConfigs.get('create_webhook').description).toMatch(/receive your transaction data/i);
    expect(toolConfigs.get('submit_webhook').description).toMatch(/data leaves your instance/i);
    expect(toolConfigs.get('trigger_transaction_webhook').description).toMatch(/sent to the webhook URL/i);
  });

  it('explain that a 404 means webhooks are switched off, not missing', () => {
    const { server, toolConfigs } = createMockServer();
    registerWebhookTools(server, mockClient);
    expect(toolConfigs.get('get_webhooks').description).toMatch(/allow_webhooks/);
  });

  it('mark every destructive tool as such', () => {
    const { server, toolConfigs } = createMockServer();
    registerWebhookTools(server, mockClient);
    for (const name of ['delete_webhook', 'delete_webhook_message', 'delete_webhook_message_attempt']) {
      expect(toolConfigs.get(name).annotations.destructiveHint, name).toBe(true);
    }
  });
});
