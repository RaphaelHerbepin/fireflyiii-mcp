import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  AggregateRangeTooLargeError,
  accountBalanceHistory,
  aggregateTransactions,
  budgetPerformance,
  collectSplits,
  findUncategorised,
  MAX_AGGREGATE_PAGES,
  monthlyBreakdown,
  spendingRatios,
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

describe('monthlyBreakdown', () => {
  it('returns a dense matrix with a column per month', async () => {
    const client = clientReturning(
      splitsPage([
        { type: 'withdrawal', amount: '10.00', date: '2025-01-05', budget_name: 'Fixes', budget_id: '1' },
        { type: 'withdrawal', amount: '20.00', date: '2025-03-05', budget_name: 'Fixes', budget_id: '1' },
      ]),
    );
    const result = await monthlyBreakdown(client, { start: '2025-01-01', end: '2025-03-31', dimension: 'budget' });
    expect(result.months).toEqual(['2025-01', '2025-02', '2025-03']);
    const row = result.currencies[0].rows[0];
    // Dense, so position carries meaning: a gap would have to be counted rather than read.
    expect(row.values).toEqual(['10.00', '0.00', '20.00']);
    expect(row.total).toBe('30.00');
  });

  it('returns amounts as strings, not numbers', async () => {
    // The brief's table says number[], but its own acceptance criterion forbids floats for money.
    const client = clientReturning(
      splitsPage([{ type: 'withdrawal', amount: '0.10', date: '2025-01-05', budget_name: 'B', budget_id: '1' }]),
    );
    const result = await monthlyBreakdown(client, { start: '2025-01-01', end: '2025-01-31', dimension: 'budget' });
    expect(typeof result.currencies[0].rows[0].values[0]).toBe('string');
  });

  it('excludes transfers from a budget dimension', async () => {
    const client = clientReturning(
      splitsPage([
        { type: 'withdrawal', amount: '10.00', date: '2025-01-05', budget_name: 'B', budget_id: '1' },
        { type: 'transfer', amount: '500.00', date: '2025-01-06' },
      ]),
    );
    const result = await monthlyBreakdown(client, { start: '2025-01-01', end: '2025-01-31', dimension: 'budget' });
    expect(result.currencies[0].rows[0].total).toBe('10.00');
    expect(result.note).toMatch(/withdrawals/i);
  });

  it('separates currencies into their own matrices', async () => {
    const client = clientReturning(
      splitsPage([
        { type: 'withdrawal', amount: '10.00', date: '2025-01-05', category_name: 'A', category_id: '1' },
        {
          type: 'withdrawal',
          amount: '20.00',
          date: '2025-01-06',
          category_name: 'A',
          category_id: '1',
          currency_code: 'USD',
        },
      ]),
    );
    const result = await monthlyBreakdown(client, { start: '2025-01-01', end: '2025-01-31', dimension: 'category' });
    expect(result.multi_currency).toBe(true);
    expect(result.currencies.map((c) => c.currency_code).sort()).toEqual(['EUR', 'USD']);
  });
});

describe('spendingRatios', () => {
  const insightClient = (entries: ReadonlyArray<Record<string, unknown>>, noBudget: unknown = []) =>
    ({
      get: vi.fn(async (path: string) => (path.includes('no-budget') ? noBudget : entries)),
    }) as unknown as FireflyClient;

  it('splits spending across caller-defined groups and sums to exactly 100', async () => {
    const client = insightClient([
      { id: '1', name: 'Fixes', difference: '-1000.00', currency_code: 'EUR' },
      { id: '2', name: 'Plaisirs', difference: '-500.00', currency_code: 'EUR' },
      { id: '3', name: 'Autres', difference: '-500.00', currency_code: 'EUR' },
    ]);
    const result = await spendingRatios(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      groups: { Needs: ['Fixes'], Wants: ['Plaisirs', 'Autres'] },
    });
    expect(result.groups.map((g) => g.percentage)).toEqual([50, 50]);
    expect(result.groups.reduce((a, g) => a + g.percentage_basis_points, 0)).toBe(10000);
  });

  it('reports a group naming a budget that does not exist', async () => {
    // A typo in a budget name must be visible, not silently contribute zero.
    const client = insightClient([{ id: '1', name: 'Fixes', difference: '-100.00', currency_code: 'EUR' }]);
    const result = await spendingRatios(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      groups: { Needs: ['Fixes', 'Fixe incompressible'] },
    });
    expect(result.unknown_budgets).toEqual(['Fixe incompressible']);
  });

  it('puts budgets the caller did not group into an explicit bucket', async () => {
    const client = insightClient([
      { id: '1', name: 'Fixes', difference: '-100.00', currency_code: 'EUR' },
      { id: '2', name: 'Forgotten', difference: '-50.00', currency_code: 'EUR' },
    ]);
    const result = await spendingRatios(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      groups: { Needs: ['Fixes'] },
    });
    expect(result.groups.find((g) => g.name === '(ungrouped)')?.total).toBe('50.00');
  });

  it('matches budget names case-insensitively and ignores surrounding spaces', async () => {
    const client = insightClient([
      { id: '1', name: 'Fixes incompressibles', difference: '-100.00', currency_code: 'EUR' },
    ]);
    const result = await spendingRatios(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      groups: { Needs: ['  fixes INCOMPRESSIBLES  '] },
    });
    expect(result.unknown_budgets).toEqual([]);
    expect(result.groups[0].total).toBe('100.00');
  });

  it('includes unbudgeted spending so the shares describe all expenses', async () => {
    const client = insightClient(
      [{ id: '1', name: 'Fixes', difference: '-100.00', currency_code: 'EUR' }],
      [{ difference: '-100.00', currency_code: 'EUR' }],
    );
    const result = await spendingRatios(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      groups: { Needs: ['Fixes'] },
    });
    expect(result.groups.find((g) => g.name === '(no budget)')?.total).toBe('100.00');
    expect(result.total).toBe('200.00');
  });
});

describe('findUncategorised', () => {
  it('counts without fetching the rows unless asked', async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes('transactions-without-budget')) {
        return { data: [], meta: { pagination: { current_page: 1, total_pages: 1, total: 42 } } };
      }
      return [{ difference: '-500.00', currency_code: 'EUR' }];
    });
    const result = await findUncategorised({ get } as unknown as FireflyClient, {
      start: '2025-01-01',
      end: '2025-01-31',
      missing: 'budget',
    });
    expect(result.without_budget?.count).toBe(42);
    expect(result.transactions).toBeUndefined();
    // limit=1 is enough to read the total out of the pagination block.
    expect(get).toHaveBeenCalledWith('/budgets/transactions-without-budget', expect.objectContaining({ limit: 1 }));
  });

  it('returns compact rows when include_transactions is set', async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes('transactions-without-budget')) {
        return {
          data: [
            {
              id: '5',
              type: 'transactions',
              attributes: {
                transactions: [
                  {
                    type: 'withdrawal',
                    amount: '12.00',
                    date: '2025-01-05',
                    description: 'x',
                    currency_code: 'EUR',
                    budget_id: null,
                    category_id: null,
                    tags: [],
                  },
                ],
              },
            },
          ],
          meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
        };
      }
      return [{ difference: '-12.00', currency_code: 'EUR' }];
    });
    const result = await findUncategorised({ get } as unknown as FireflyClient, {
      start: '2025-01-01',
      end: '2025-01-31',
      missing: 'budget',
      include_transactions: true,
      limit: 10,
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions?.[0]).not.toHaveProperty('sepa_cc');
  });
});

describe('budgetPerformance', () => {
  const perfClient = (
    budgets: ReadonlyArray<Record<string, unknown>>,
    limits: ReadonlyArray<Record<string, unknown>>,
    spent: ReadonlyArray<Record<string, unknown>>,
    noBudget: ReadonlyArray<Record<string, unknown>> = [],
  ) =>
    ({
      get: vi.fn(async (path: string) => {
        if (path === '/budgets') {
          return {
            data: budgets.map((b) => ({ id: String(b.id), type: 'budgets', attributes: b })),
            meta: { pagination: { current_page: 1, total_pages: 1, total: budgets.length } },
          };
        }
        if (path.includes('/limits')) {
          return {
            data: limits.map((l, i) => ({ id: String(i + 1), type: 'budget_limits', attributes: l })),
            meta: { pagination: { current_page: 1, total_pages: 1, total: limits.length } },
          };
        }
        if (path.includes('no-budget')) return noBudget;
        return spent;
      }),
    }) as unknown as FireflyClient;

  it('reports limit, spent, remaining and percentage used', async () => {
    const client = perfClient(
      [{ id: '1', name: 'Fixes' }],
      [{ start: '2025-01-01', end: '2025-01-31', amount: '1000.00', currency_code: 'EUR' }],
      [{ id: '1', name: 'Fixes', difference: '-750.00', currency_code: 'EUR' }],
    );
    const result = await budgetPerformance(client, { start: '2025-01-01', end: '2025-01-31' });
    expect(result.budgets[0]).toMatchObject({
      name: 'Fixes',
      limit: '1000.00',
      spent: '750.00',
      remaining: '250.00',
      percent_used: 75,
      limits_counted: 1,
      partial_limit_overlap: false,
    });
  });

  it('sums overlapping limits and flags a partial overlap rather than pro-rating', async () => {
    // A monthly limit is not a daily allowance; dividing it by days would invent a figure with no
    // counterpart in Firefly.
    const client = perfClient(
      [{ id: '1', name: 'Fixes' }],
      [
        { start: '2025-01-01', end: '2025-01-31', amount: '1000.00', currency_code: 'EUR' },
        { start: '2025-02-01', end: '2025-02-28', amount: '1000.00', currency_code: 'EUR' },
      ],
      [{ id: '1', name: 'Fixes', difference: '-500.00', currency_code: 'EUR' }],
    );
    const result = await budgetPerformance(client, { start: '2025-01-15', end: '2025-02-15' });
    expect(result.budgets[0].limits_counted).toBe(2);
    expect(result.budgets[0].partial_limit_overlap).toBe(true);
    expect(result.budgets[0].limit).toBe('2000.00');
    expect(result.note).toMatch(/pro-rated/);
  });

  it('includes unbudgeted spending so the shares cover all expenses', async () => {
    const client = perfClient(
      [{ id: '1', name: 'Fixes' }],
      [{ start: '2025-01-01', end: '2025-01-31', amount: '1000.00', currency_code: 'EUR' }],
      [{ id: '1', name: 'Fixes', difference: '-500.00', currency_code: 'EUR' }],
      [{ difference: '-500.00', currency_code: 'EUR' }],
    );
    const result = await budgetPerformance(client, { start: '2025-01-01', end: '2025-01-31' });
    expect(result.budgets.map((b) => b.name)).toContain('(no budget)');
    expect(result.total_spent).toBe('1000.00');
    expect(result.budgets.reduce((a, b) => a + b.share_of_expenses, 0)).toBe(100);
  });

  it('reports a budget with no limit rather than inventing one', async () => {
    const client = perfClient(
      [{ id: '1', name: 'Unlimited' }],
      [],
      [{ id: '1', name: 'Unlimited', difference: '-100.00', currency_code: 'EUR' }],
    );
    const result = await budgetPerformance(client, { start: '2025-01-01', end: '2025-01-31' });
    expect(result.budgets[0]).toMatchObject({ limit: null, remaining: null, percent_used: null, spent: '100.00' });
  });
});

describe('accountBalanceHistory', () => {
  it('turns chart series into a dated matrix', async () => {
    const client = {
      get: vi.fn(async () => [
        { label: 'Compte courant', currency_code: 'EUR', entries: { '2025-01-31': 1500.5, '2025-02-28': 1720.25 } },
      ]),
    } as unknown as FireflyClient;
    const result = await accountBalanceHistory(client, { start: '2025-01-01', end: '2025-02-28' });
    expect(result.dates).toEqual(['2025-01-31', '2025-02-28']);
    expect(result.accounts[0].balances).toEqual([1500.5, 1720.25]);
  });

  it('reports account ids it could not match to a series', async () => {
    // The chart endpoint has no account filter, so matching is by name and can fail. Saying so beats
    // returning a silently empty result.
    const client = {
      get: vi.fn(async (path: string) => {
        if (path === '/accounts') {
          return {
            data: [{ id: '1', type: 'accounts', attributes: { name: 'Compte courant' } }],
            meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
          };
        }
        return [{ label: 'Compte courant', currency_code: 'EUR', entries: { '2025-01-31': 100 } }];
      }),
    } as unknown as FireflyClient;
    const result = await accountBalanceHistory(client, {
      start: '2025-01-01',
      end: '2025-01-31',
      account_ids: ['1', '999'],
    });
    expect(result.accounts).toHaveLength(1);
    expect(result.unmatched_account_ids).toEqual(['999']);
  });

  it('states that balances are numbers from the endpoint', async () => {
    const client = { get: vi.fn(async () => []) } as unknown as FireflyClient;
    const result = await accountBalanceHistory(client, { start: '2025-01-01', end: '2025-01-31' });
    expect(result.note).toMatch(/numbers/i);
  });
});
