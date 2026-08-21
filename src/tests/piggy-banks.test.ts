import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  createPiggyBank,
  deletePiggyBank,
  fetchPiggyBankEvents,
  fetchPiggyBanks,
  registerPiggyBankTools,
  updatePiggyBank,
} from '../tools/piggy-banks.js';
import { createMockServer } from './_helpers.js';

const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as FireflyClient;

const listFixture = {
  data: [
    {
      id: '2',
      type: 'piggy_banks',
      attributes: { name: 'Holiday Fund', current_amount: '500.00', target_amount: '2000.00' },
      links: { self: 'https://firefly.example.com/api/v1/piggy-banks/2' },
    },
  ],
  meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
};

describe('fetchPiggyBanks', () => {
  it('calls /piggy-banks with pagination', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchPiggyBanks(mockClient, { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/piggy-banks', { page: 1, limit: 50 });
  });

  it('returns flat items with pagination', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    const result = await fetchPiggyBanks(mockClient, { page: 1, limit: 50 });
    expect(result.data[0]).toEqual({
      name: 'Holiday Fund',
      current_amount: '500.00',
      target_amount: '2000.00',
      id: '2',
    });
    expect(result.pagination).toEqual({ page: 1, totalPages: 1, total: 1 });
  });
});

const piggyBankSingleFixture = {
  data: {
    id: '4',
    type: 'piggy_banks',
    attributes: { name: 'Vacation', target_amount: '1000.00', account_id: '1' },
    links: {},
  },
};

describe('createPiggyBank', () => {
  it('sends accounts[] and a currency, which 6.5.5 requires', async () => {
    // Sending a bare account_id gets 422 from a real 6.5.5 instance: the spec lists it as required
    // but never declares it as a property, and the instance settles it. See phantom-routes.test.ts.
    mockClient.post = vi.fn().mockResolvedValueOnce(piggyBankSingleFixture);
    await createPiggyBank(mockClient, { name: 'Vacation', account_id: '1' });
    expect(mockClient.post).toHaveBeenCalledWith('/piggy-banks', {
      name: 'Vacation',
      accounts: [{ account_id: '1' }],
      transaction_currency_code: 'EUR',
    });
  });

  it('passes an explicit currency through', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(piggyBankSingleFixture);
    await createPiggyBank(mockClient, { name: 'Vacation', account_id: '1', currency_code: 'USD' });
    expect(mockClient.post).toHaveBeenCalledWith(
      '/piggy-banks',
      expect.objectContaining({ transaction_currency_code: 'USD' }),
    );
  });
  it('returns unwrapped single', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(piggyBankSingleFixture);
    const result = await createPiggyBank(mockClient, { name: 'Vacation', account_id: '1' });
    expect(result).toEqual({ name: 'Vacation', target_amount: '1000.00', account_id: '1', id: '4' });
  });
});

describe('updatePiggyBank', () => {
  it('puts to /piggy-banks/:id', async () => {
    mockClient.put = vi.fn().mockResolvedValueOnce(piggyBankSingleFixture);
    await updatePiggyBank(mockClient, '4', { target_amount: '2000.00' });
    expect(mockClient.put).toHaveBeenCalledWith('/piggy-banks/4', { target_amount: '2000.00' });
  });
});

describe('deletePiggyBank', () => {
  it('calls delete and returns confirmation', async () => {
    mockClient.delete = vi.fn().mockResolvedValueOnce(undefined);
    const result = await deletePiggyBank(mockClient, '4');
    expect(mockClient.delete).toHaveBeenCalledWith('/piggy-banks/4');
    expect(result).toEqual({ deleted: true, id: '4' });
  });
});

const piggyEventFixture = {
  data: [{ id: '1', type: 'piggy_bank_events', attributes: { amount: '50.00', date: '2026-01-15' }, links: {} }],
  meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
};

describe('fetchPiggyBankEvents', () => {
  it('calls /piggy-banks/:id/events', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(piggyEventFixture);
    await fetchPiggyBankEvents(mockClient, '3', { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/piggy-banks/3/events', { page: 1, limit: 50 });
  });
});

describe('handler smoke — piggy-banks', () => {
  it('get_piggy_banks handler returns text content on success', async () => {
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockResolvedValueOnce(listFixture) } as unknown as FireflyClient;
    registerPiggyBankTools(server, client);
    const result = await handlers.get('get_piggy_banks')!({});
    expect(result).toMatchObject({ content: [{ type: 'text', text: expect.any(String) }] });
  });

  it('get_piggy_banks handler returns isError on failure', async () => {
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockRejectedValueOnce(new Error('Network error')) } as unknown as FireflyClient;
    registerPiggyBankTools(server, client);
    const result = await handlers.get('get_piggy_banks')!({});
    expect(result).toMatchObject({ isError: true });
  });
});
