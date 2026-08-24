import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  createExchangeRate,
  deleteExchangeRateOnDate,
  deleteExchangeRatesForPair,
  fetchExchangeRateById,
  fetchExchangeRateOnDate,
  fetchExchangeRates,
  fetchExchangeRatesForPair,
  registerExchangeRateTools,
  updateExchangeRateOnDate,
} from '../tools/exchange-rates.js';
import { createMockServer } from './_helpers.js';

const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as FireflyClient;

const rateSingle = {
  data: {
    id: '3',
    type: 'currency_exchange_rates',
    attributes: { from_currency_code: 'EUR', to_currency_code: 'USD', date: '2025-03-01', rate: '1.0842' },
    links: {},
  },
};
const rateList = { data: [rateSingle.data], meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } } };

describe('exchange rate reads', () => {
  it('lists every rate', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(rateList);
    await fetchExchangeRates(mockClient, { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/exchange-rates', { page: 1, limit: 50 });
  });

  it('reads one rate by id', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(rateSingle);
    expect(await fetchExchangeRateById(mockClient, '3')).toMatchObject({ id: '3', rate: '1.0842' });
  });

  it('reads a pair from /exchange-rates/{from}/{to}, not the POST-only by-currencies path', async () => {
    // Upstream's get_exchange_rate called /exchange-rates/by-currencies/{from}/{to}, which exists for
    // POST only and answers 404 for a read.
    mockClient.get = vi.fn().mockResolvedValueOnce(rateList);
    await fetchExchangeRatesForPair(mockClient, 'EUR', 'USD');
    expect(mockClient.get).toHaveBeenCalledWith('/exchange-rates/EUR/USD');
  });

  it('reads a pair on a date', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(rateSingle);
    await fetchExchangeRateOnDate(mockClient, 'EUR', 'USD', '2025-03-01');
    expect(mockClient.get).toHaveBeenCalledWith('/exchange-rates/EUR/USD/2025-03-01');
  });

  it('encodes currency codes', async () => {
    // Codes are caller-supplied and reach the path directly.
    mockClient.get = vi.fn().mockResolvedValueOnce(rateList);
    await fetchExchangeRatesForPair(mockClient, 'A/B', 'C D');
    expect(mockClient.get).toHaveBeenCalledWith('/exchange-rates/A%2FB/C%20D');
  });
});

describe('exchange rate writes', () => {
  it('creates a rate', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(rateSingle);
    await createExchangeRate(mockClient, { from: 'EUR', to: 'USD', date: '2025-03-01', rate: '1.0842' });
    expect(mockClient.post).toHaveBeenCalledWith('/exchange-rates', {
      from: 'EUR',
      to: 'USD',
      date: '2025-03-01',
      rate: '1.0842',
    });
  });

  it('updates by pair and date, no id needed', async () => {
    mockClient.put = vi.fn().mockResolvedValueOnce(rateSingle);
    await updateExchangeRateOnDate(mockClient, 'EUR', 'USD', '2025-03-01', { rate: '1.09' });
    expect(mockClient.put).toHaveBeenCalledWith('/exchange-rates/EUR/USD/2025-03-01', { rate: '1.09' });
  });

  it('distinguishes deleting one date from deleting a whole pair', async () => {
    mockClient.delete = vi.fn().mockResolvedValue(undefined);
    expect(await deleteExchangeRateOnDate(mockClient, 'EUR', 'USD', '2025-03-01')).toMatchObject({
      deleted: true,
      date: '2025-03-01',
    });
    expect(mockClient.delete).toHaveBeenCalledWith('/exchange-rates/EUR/USD/2025-03-01');

    expect(await deleteExchangeRatesForPair(mockClient, 'EUR', 'USD')).toMatchObject({ deleted: true, from: 'EUR' });
    expect(mockClient.delete).toHaveBeenCalledWith('/exchange-rates/EUR/USD');
  });
});

describe('exchange rate tool safety', () => {
  it('warns that deleting a pair removes every date', () => {
    const { server, toolConfigs } = createMockServer();
    registerExchangeRateTools(server, mockClient);
    // The difference between this and the single-date delete is one path segment and a lot of data.
    expect(toolConfigs.get('delete_exchange_rates_for_pair').description).toMatch(/every.*rate/i);
    expect(toolConfigs.get('delete_exchange_rates_for_pair').annotations.destructiveHint).toBe(true);
  });
});

describe('get_currency_related', () => {
  it('builds the sub-resource path and encodes the code', async () => {
    const { fetchCurrencyRelated } = await import('../tools/currencies.js');
    const get = vi.fn().mockResolvedValueOnce({ data: [], meta: {} });
    await fetchCurrencyRelated({ get } as unknown as FireflyClient, 'EU R', 'transactions', {
      start: '2025-01-01',
      limit: 10,
    });
    expect(get).toHaveBeenCalledWith('/currencies/EU%20R/transactions', {
      page: undefined,
      limit: 10,
      start: '2025-01-01',
    });
  });

  it('covers every sub-resource the API defines', async () => {
    const { CURRENCY_SUBRESOURCES } = await import('../tools/currencies.js');
    // The coverage script expands this table, so a missing entry silently drops an operation.
    expect([...CURRENCY_SUBRESOURCES].sort()).toEqual([
      'accounts',
      'available-budgets',
      'bills',
      'budget-limits',
      'recurrences',
      'rules',
      'transactions',
    ]);
  });
});
