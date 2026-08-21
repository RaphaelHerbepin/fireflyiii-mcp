import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  AggregateRangeTooLargeError,
  aggregateTransactions,
  collectSplits,
  MAX_AGGREGATE_PAGES,
} from '../tools/aggregates.js';
import type { JsonApiListResponse } from '../transform.js';

/** A page of transaction groups, each with one split. */
function page(ids: readonly string[], currentPage: number, totalPages: number): JsonApiListResponse {
  return {
    data: ids.map((id) => ({
      id,
      type: 'transactions',
      attributes: {
        user: '1',
        group_title: null,
        transactions: [
          {
            transaction_journal_id: `j${id}`,
            type: 'withdrawal',
            date: '2025-03-15T12:00:00+01:00',
            amount: '10.00',
            currency_code: 'EUR',
            currency_decimal_places: 2,
            description: `tx ${id}`,
            category_id: '1',
            category_name: 'Alimentation',
            budget_id: '2',
            budget_name: 'Variables essentielles',
            source_id: '3',
            source_name: 'Compte courant',
            destination_id: '4',
            destination_name: 'Coopérative U',
            tags: [],
          },
        ],
      },
      links: {},
    })),
    meta: { pagination: { current_page: currentPage, total_pages: totalPages, total: ids.length * totalPages } },
  };
}

describe('collectSplits', () => {
  it('walks every page and flattens groups into splits', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(page(['1', '2'], 1, 3))
      .mockResolvedValueOnce(page(['3', '4'], 2, 3))
      .mockResolvedValueOnce(page(['5', '6'], 3, 3));
    const splits = await collectSplits({ get } as unknown as FireflyClient, '/transactions', {});
    expect(get).toHaveBeenCalledTimes(3);
    expect(splits).toHaveLength(6);
    expect(splits[0]).toMatchObject({ group_id: '1', amount: '10.00', type: 'withdrawal' });
  });

  it('carries the group id onto every split', async () => {
    const multi: JsonApiListResponse = {
      data: [
        {
          id: '77',
          type: 'transactions',
          attributes: {
            transactions: [
              { type: 'withdrawal', amount: '5.00', date: '2025-01-01', currency_code: 'EUR' },
              { type: 'withdrawal', amount: '7.00', date: '2025-01-01', currency_code: 'EUR' },
            ],
          },
        },
      ],
      meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
    };
    const get = vi.fn().mockResolvedValueOnce(multi);
    const splits = await collectSplits({ get } as unknown as FireflyClient, '/transactions', {});
    expect(splits.map((s) => s.group_id)).toEqual(['77', '77']);
  });

  it('refuses an oversized range after one request, not fifty', async () => {
    // Reading total_pages from page 1 and stopping there costs one wasted request. Discovering the
    // problem by walking the pages would cost fifty, and time out first.
    const get = vi.fn().mockResolvedValueOnce(page(['1'], 1, MAX_AGGREGATE_PAGES + 1));
    await expect(collectSplits({ get } as unknown as FireflyClient, '/transactions', {})).rejects.toThrow(
      AggregateRangeTooLargeError,
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('names the limit and what to do about it', async () => {
    const get = vi.fn().mockResolvedValueOnce(page(['1'], 1, 200));
    await expect(collectSplits({ get } as unknown as FireflyClient, '/transactions', {})).rejects.toThrow(
      /narrow the date range/i,
    );
  });

  it('accepts a range exactly at the cap', async () => {
    const get = vi.fn();
    for (let p = 1; p <= MAX_AGGREGATE_PAGES; p++) get.mockResolvedValueOnce(page(['x'], p, MAX_AGGREGATE_PAGES));
    const splits = await collectSplits({ get } as unknown as FireflyClient, '/transactions', {});
    expect(splits).toHaveLength(MAX_AGGREGATE_PAGES);
  });

  it('requests full pages and passes the caller filters through', async () => {
    const get = vi.fn().mockResolvedValueOnce(page(['1'], 1, 1));
    await collectSplits({ get } as unknown as FireflyClient, '/transactions', {
      start: '2025-01-01',
      end: '2025-01-31',
    });
    expect(get).toHaveBeenCalledWith('/transactions', {
      start: '2025-01-01',
      end: '2025-01-31',
      limit: 100,
      page: 1,
    });
  });

  it('copes with a response carrying no pagination block', async () => {
    const get = vi.fn().mockResolvedValueOnce({ data: [] });
    expect(await collectSplits({ get } as unknown as FireflyClient, '/transactions', {})).toEqual([]);
  });

  it('normalises a missing tags array to an empty one', async () => {
    const get = vi.fn().mockResolvedValueOnce({
      data: [{ id: '1', type: 'transactions', attributes: { transactions: [{ type: 'withdrawal', amount: '1.00' }] } }],
      meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
    });
    const splits = await collectSplits({ get } as unknown as FireflyClient, '/transactions', {});
    expect(splits[0].tags).toEqual([]);
  });
});

/** Builds a one-page response from explicit split descriptions. */
function splitsPage(splits: ReadonlyArray<Record<string, unknown>>): JsonApiListResponse {
  return {
    data: splits.map((split, i) => ({
      id: String(i + 1),
      type: 'transactions',
      attributes: {
        transactions: [
          {
            transaction_journal_id: `j${i + 1}`,
            currency_code: 'EUR',
            currency_decimal_places: 2,
            tags: [],
            ...split,
          },
        ],
      },
      links: {},
    })),
    meta: { pagination: { current_page: 1, total_pages: 1, total: splits.length } },
  };
}

const clientReturning = (response: JsonApiListResponse): FireflyClient =>
  ({ get: vi.fn().mockResolvedValue(response) }) as unknown as FireflyClient;

describe('aggregateTransactions', () => {
  it('totals by category and counts the rows behind each total', async () => {
    const client = clientReturning(
      splitsPage([
        { type: 'withdrawal', amount: '10.00', date: '2025-01-05', category_name: 'Alimentation' },
        { type: 'withdrawal', amount: '15.50', date: '2025-01-06', category_name: 'Alimentation' },
        { type: 'withdrawal', amount: '30.00', date: '2025-01-07', category_name: 'Transport' },
      ]),
    );
    const result = await aggregateTransactions(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      group_by: 'category',
    });
    const food = result.groups.find((g) => g.label === 'Alimentation');
    expect(food).toMatchObject({ total: '25.50', count: 2, currency_code: 'EUR' });
    expect(result.totals).toEqual([{ currency_code: 'EUR', total: '55.50', count: 3 }]);
  });

  it('labels rows with no category rather than dropping them', async () => {
    // An uncategorised total that silently vanishes makes the percentages wrong and unexplainable.
    const client = clientReturning(
      splitsPage([
        { type: 'withdrawal', amount: '10.00', date: '2025-01-05', category_name: null },
        { type: 'withdrawal', amount: '5.00', date: '2025-01-06', category_name: 'Transport' },
      ]),
    );
    const result = await aggregateTransactions(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      group_by: 'category',
    });
    expect(result.groups.find((g) => g.key === null)).toMatchObject({ label: '(none)', total: '10.00' });
  });

  it('buckets by month on the date string, never through Date', async () => {
    // new Date('2025-02-01T00:30:00+01:00') is 2025-01-31T23:30Z, which would land in January.
    const client = clientReturning(
      splitsPage([{ type: 'withdrawal', amount: '10.00', date: '2025-02-01T00:30:00+01:00' }]),
    );
    const result = await aggregateTransactions(client, { start: '2025-01-01', end: '2025-12-31', group_by: 'month' });
    expect(result.groups.map((g) => g.key)).toEqual(['2025-02']);
  });

  it('groups each currency separately instead of adding them together', async () => {
    const client = clientReturning(
      splitsPage([
        { type: 'withdrawal', amount: '10.00', date: '2025-01-05', category_name: 'Abonnements', currency_code: 'EUR' },
        { type: 'withdrawal', amount: '49.99', date: '2025-01-06', category_name: 'Abonnements', currency_code: 'USD' },
      ]),
    );
    const result = await aggregateTransactions(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      group_by: 'category',
    });
    expect(result.multi_currency).toBe(true);
    expect(result.groups).toHaveLength(2);
    expect(result.totals).toHaveLength(2);
  });

  it('excludes transfers from a budget breakdown and says so', async () => {
    // Firefly refuses a budget on a transfer by design, so including them would only ever contribute
    // a zero row — and a zero row reads as "nothing spent" rather than "not applicable".
    const client = clientReturning(
      splitsPage([
        { type: 'withdrawal', amount: '10.00', date: '2025-01-05', budget_name: 'Plaisirs et loisirs' },
        { type: 'transfer', amount: '300.00', date: '2025-01-06', budget_name: null },
      ]),
    );
    const result = await aggregateTransactions(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      group_by: 'budget',
      type: 'all',
    });
    expect(result.totals[0].total).toBe('10.00');
    expect(result.note).toMatch(/budgets only apply to withdrawals/i);
  });

  it('rejects a budget breakdown explicitly asked to cover transfers', async () => {
    await expect(
      aggregateTransactions(clientReturning(splitsPage([])), {
        start: '2025-01-01',
        end: '2025-01-31',
        group_by: 'budget',
        type: 'transfer',
      }),
    ).rejects.toThrow(/cannot carry a budget/i);
  });

  it('filters by type when asked', async () => {
    const client = clientReturning(
      splitsPage([
        { type: 'withdrawal', amount: '10.00', date: '2025-01-05', category_name: 'A' },
        { type: 'deposit', amount: '200.00', date: '2025-01-06', category_name: 'A' },
      ]),
    );
    const result = await aggregateTransactions(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      group_by: 'category',
      type: 'deposit',
    });
    expect(result.totals[0]).toMatchObject({ total: '200.00', count: 1 });
  });

  it('sorts groups by descending total so the largest come first', async () => {
    const client = clientReturning(
      splitsPage([
        { type: 'withdrawal', amount: '5.00', date: '2025-01-05', category_name: 'Small' },
        { type: 'withdrawal', amount: '50.00', date: '2025-01-06', category_name: 'Large' },
        { type: 'withdrawal', amount: '25.00', date: '2025-01-07', category_name: 'Medium' },
      ]),
    );
    const result = await aggregateTransactions(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      group_by: 'category',
    });
    expect(result.groups.map((g) => g.label)).toEqual(['Large', 'Medium', 'Small']);
  });

  it('returns no rows and a zero total for an empty period', async () => {
    const result = await aggregateTransactions(clientReturning(splitsPage([])), {
      start: '2025-01-01',
      end: '2025-01-31',
      group_by: 'category',
    });
    expect(result.groups).toEqual([]);
    expect(result.totals).toEqual([]);
  });

  it('never returns the underlying rows', async () => {
    // The entire point: a period of 2 000 transactions must answer in a few hundred tokens.
    const result = await aggregateTransactions(
      clientReturning(splitsPage([{ type: 'withdrawal', amount: '10.00', date: '2025-01-05' }])),
      { start: '2025-01-01', end: '2025-01-31', group_by: 'category' },
    );
    expect(JSON.stringify(result)).not.toContain('transaction_journal_id');
  });
});
