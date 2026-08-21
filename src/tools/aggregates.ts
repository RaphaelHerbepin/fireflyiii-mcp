/**
 * Aggregation performed on the server, so a question about eighteen months of spending does not
 * require eighteen months of transactions to cross the wire.
 *
 * Field projection makes a page of transactions affordable; it does not make 2 000 of them
 * affordable. Firefly III can already total by budget, category and period — what it does not expose
 * is the cross-cutting shapes a budget review actually asks for, notably a month-by-month series per
 * budget. These tools fill that gap and return totals, never rows.
 *
 * Every amount is handled through `src/money.ts`, in BigInt. The API returns amounts as strings for a
 * reason, and summing thousands of them as floats drifts by cents.
 */

import type { FireflyClient } from '../client.js';
import { addMoney, compareMoney, formatMoney, parseMoney, zeroMoney } from '../money.js';
import type { JsonApiListResponse } from '../transform.js';
import type { QueryParams } from '../types.js';

/**
 * Hard ceiling on how many pages one aggregate may walk. 50 pages × 100 records = 5 000 splits, which
 * covers several years of ordinary personal use while bounding the worst case: at a 30-second client
 * timeout per request, an unbounded walk over a large instance would hang rather than answer.
 */
export const MAX_AGGREGATE_PAGES = 50;

const AGGREGATE_PAGE_SIZE = 100;

export class AggregateRangeTooLargeError extends Error {
  constructor(totalPages: number, total: number) {
    super(
      `This range covers ${total} transactions across ${totalPages} pages, over the ${MAX_AGGREGATE_PAGES}-page ` +
        `limit (${MAX_AGGREGATE_PAGES * AGGREGATE_PAGE_SIZE} records). Narrow the date range and aggregate the ` +
        'periods separately. Returning a partial total silently would be worse than this error: the figure ' +
        'would look complete and be wrong.',
    );
    this.name = 'AggregateRangeTooLargeError';
  }
}

/** One transaction split, flattened out of its group and normalised for aggregation. */
export interface SplitRow {
  group_id: string;
  transaction_journal_id: string | null;
  type: string;
  /** As returned: `YYYY-MM-DD` or an RFC 3339 date-time. */
  date: string;
  /** Positive decimal string, as the API reports it. Direction lives in `type`. */
  amount: string;
  currency_code: string;
  currency_decimal_places: number;
  description: string;
  category_id: string | null;
  category_name: string | null;
  budget_id: string | null;
  budget_name: string | null;
  source_id: string | null;
  source_name: string | null;
  destination_id: string | null;
  destination_name: string | null;
  tags: string[];
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function toSplitRow(groupId: string, split: Record<string, unknown>): SplitRow {
  return {
    group_id: groupId,
    transaction_journal_id: str(split.transaction_journal_id),
    type: str(split.type) ?? 'unknown',
    date: str(split.date) ?? '',
    amount: str(split.amount) ?? '0',
    currency_code: str(split.currency_code) ?? '',
    currency_decimal_places: typeof split.currency_decimal_places === 'number' ? split.currency_decimal_places : 2,
    description: str(split.description) ?? '',
    category_id: str(split.category_id),
    category_name: str(split.category_name),
    budget_id: str(split.budget_id),
    budget_name: str(split.budget_name),
    source_id: str(split.source_id),
    source_name: str(split.source_name),
    destination_id: str(split.destination_id),
    destination_name: str(split.destination_name),
    tags: Array.isArray(split.tags) ? (split.tags as string[]) : [],
  };
}

/**
 * Pulls every page of a transaction listing and flattens the groups into splits.
 *
 * The page cap is enforced from page 1's `total_pages`, before page 2 is requested: one wasted
 * request rather than fifty, and the caller gets an answer in a second instead of timing out.
 */
export async function collectSplits(
  client: FireflyClient,
  path: string,
  query: QueryParams,
  options: { maxPages?: number } = {},
): Promise<SplitRow[]> {
  const maxPages = options.maxPages ?? MAX_AGGREGATE_PAGES;
  const rows: SplitRow[] = [];

  const first = await client.get<JsonApiListResponse>(path, {
    ...query,
    limit: AGGREGATE_PAGE_SIZE,
    page: 1,
  });
  const pagination = first.meta?.pagination;
  const totalPages = pagination?.total_pages ?? 1;

  if (totalPages > maxPages) {
    throw new AggregateRangeTooLargeError(totalPages, pagination?.total ?? totalPages * AGGREGATE_PAGE_SIZE);
  }

  const absorb = (response: JsonApiListResponse): void => {
    for (const group of response.data) {
      const splits = group.attributes?.transactions;
      if (!Array.isArray(splits)) continue;
      for (const split of splits) rows.push(toSplitRow(group.id, split as Record<string, unknown>));
    }
  };

  absorb(first);
  for (let page = 2; page <= totalPages; page++) {
    absorb(await client.get<JsonApiListResponse>(path, { ...query, limit: AGGREGATE_PAGE_SIZE, page }));
  }
  return rows;
}

// ── Grouping ──────────────────────────────────────────────────────────────────

export type GroupBy = 'category' | 'budget' | 'month' | 'type' | 'source_account' | 'destination_account' | 'tag';
export type TypeFilter = 'withdrawal' | 'deposit' | 'transfer' | 'all';

export interface AggregateGroup {
  /** Stable identifier where one exists, `null` for the "no category / no budget" bucket. */
  key: string | null;
  label: string;
  currency_code: string;
  total: string;
  count: number;
}

export interface AggregateResult {
  start: string;
  end: string;
  group_by: GroupBy;
  type: TypeFilter;
  /** True when more than one currency appears; totals are then per-currency and not comparable. */
  multi_currency: boolean;
  groups: AggregateGroup[];
  totals: Array<{ currency_code: string; total: string; count: number }>;
  note?: string;
}

/**
 * Firefly III only allows budgets on withdrawals — a transfer between two asset accounts cannot carry
 * one, by design. Including transfers in a per-budget breakdown therefore only ever adds a zero row,
 * which reads as "nothing was spent here" rather than "this does not apply".
 */
const BUDGET_NOTE =
  'Budgets only apply to withdrawals in Firefly III, so deposits and transfers are excluded from this ' +
  'breakdown. A transfer between two asset accounts cannot carry a budget.';

function groupKeyFor(row: SplitRow, groupBy: GroupBy): Array<{ key: string | null; label: string }> {
  switch (groupBy) {
    case 'category':
      return [{ key: row.category_id, label: row.category_name ?? '(none)' }];
    case 'budget':
      return [{ key: row.budget_id, label: row.budget_name ?? '(none)' }];
    case 'month':
      // Slice the string rather than parsing it. `2025-02-01T00:30:00+01:00` through `new Date` is
      // 2025-01-31T23:30Z, which would put a February transaction in January.
      return [{ key: row.date.slice(0, 7), label: row.date.slice(0, 7) }];
    case 'type':
      return [{ key: row.type, label: row.type }];
    case 'source_account':
      return [{ key: row.source_id, label: row.source_name ?? '(none)' }];
    case 'destination_account':
      return [{ key: row.destination_id, label: row.destination_name ?? '(none)' }];
    case 'tag':
      return row.tags.length > 0
        ? row.tags.map((tag) => ({ key: tag, label: tag }))
        : [{ key: null, label: '(untagged)' }];
  }
}

/** Query filters shared by the aggregate tools. */
function rangeQuery(params: { start: string; end: string; type?: TypeFilter }): QueryParams {
  const query: QueryParams = { start: params.start, end: params.end };
  if (params.type && params.type !== 'all') query.type = params.type;
  return query;
}

export async function aggregateTransactions(
  client: FireflyClient,
  params: { start: string; end: string; group_by: GroupBy; type?: TypeFilter; currency_code?: string },
): Promise<AggregateResult> {
  const requestedType: TypeFilter = params.type ?? 'all';

  if (params.group_by === 'budget' && requestedType === 'transfer') {
    throw new Error(
      'Transfers cannot carry a budget in Firefly III, so grouping transfers by budget would always ' +
        'return nothing. Group by category or account instead, or aggregate withdrawals.',
    );
  }

  // For a budget breakdown, narrow to withdrawals rather than filtering after the fact: it is both
  // correct and a smaller query.
  const effectiveType: TypeFilter = params.group_by === 'budget' ? 'withdrawal' : requestedType;
  const rows = await collectSplits(client, '/transactions', rangeQuery({ ...params, type: effectiveType }));

  // Filter by type here as well as in the query. The query narrows what crosses the wire; this makes
  // the result independent of whether the API honoured the parameter. For the budget case that is not
  // belt-and-braces but correctness: a transfer landing in a per-budget total would be silently wrong.
  const filtered = rows.filter(
    (row) =>
      (effectiveType === 'all' || row.type.toLowerCase() === effectiveType) &&
      (!params.currency_code || row.currency_code === params.currency_code),
  );

  // Keyed by currency first: adding EUR to USD would be arithmetic on incomparable things.
  const buckets = new Map<string, { group: AggregateGroup; sum: ReturnType<typeof zeroMoney> }>();
  const currencyTotals = new Map<string, { sum: ReturnType<typeof zeroMoney>; count: number }>();

  for (const row of filtered) {
    const amount = parseMoney(row.amount);
    for (const { key, label } of groupKeyFor(row, params.group_by)) {
      const bucketId = `${row.currency_code}\u0000${key ?? ''}\u0000${label}`;
      const existing = buckets.get(bucketId);
      if (existing) {
        existing.sum = addMoney(existing.sum, amount);
        existing.group.count++;
      } else {
        buckets.set(bucketId, {
          group: { key, label, currency_code: row.currency_code, total: '0', count: 1 },
          sum: amount,
        });
      }
    }
    const currency = currencyTotals.get(row.currency_code) ?? { sum: zeroMoney(0), count: 0 };
    currency.sum = addMoney(currency.sum, amount);
    currency.count++;
    currencyTotals.set(row.currency_code, currency);
  }

  const groups = [...buckets.values()]
    .map(({ group, sum }) => ({ ...group, total: formatMoney(sum, 2) }))
    .sort((a, b) => compareMoney(parseMoney(b.total), parseMoney(a.total)) || a.label.localeCompare(b.label));

  const totals = [...currencyTotals.entries()]
    .map(([currency_code, { sum, count }]) => ({ currency_code, total: formatMoney(sum, 2), count }))
    .sort((a, b) => a.currency_code.localeCompare(b.currency_code));

  const result: AggregateResult = {
    start: params.start,
    end: params.end,
    group_by: params.group_by,
    type: requestedType,
    multi_currency: totals.length > 1,
    groups,
    totals,
  };
  if (params.group_by === 'budget' && requestedType !== 'withdrawal') result.note = BUDGET_NOTE;
  return result;
}
