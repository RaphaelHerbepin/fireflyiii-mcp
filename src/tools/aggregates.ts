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

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FireflyClient } from '../client.js';
import {
  absMoney,
  addMoney,
  basisPoints,
  compareMoney,
  formatMoney,
  largestRemainderPercentages,
  type Money,
  parseMoney,
  zeroMoney,
} from '../money.js';
import { projectUnwrappedList } from '../projection.js';
import type { JsonApiListResponse } from '../transform.js';
import { unwrapList } from '../transform.js';
import type { QueryParams } from '../types.js';
import { READ_ANNOTATIONS } from './_annotations.js';
import { dateSchema, defineTool } from './_helpers.js';

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

// ── Monthly breakdown ─────────────────────────────────────────────────────────

export interface BreakdownRow {
  label: string;
  /** One decimal string per month in `months`, dense — a zero month is '0.00', never a gap. */
  values: string[];
  total: string;
}

export interface MonthlyBreakdown {
  start: string;
  end: string;
  dimension: 'budget' | 'category';
  months: string[];
  multi_currency: boolean;
  currencies: Array<{ currency_code: string; rows: BreakdownRow[] }>;
  note?: string;
}

/** Inclusive list of `YYYY-MM` between two dates, derived from the strings to avoid timezone drift. */
function monthsBetween(start: string, end: string): string[] {
  const months: string[] = [];
  let [year, month] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
  const [endYear, endMonth] = [Number(end.slice(0, 4)), Number(end.slice(5, 7))];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return months;
}

/**
 * A month-by-month series per budget or category — the shape a 50/25/25 review asks for, and the one
 * the Firefly API does not provide directly.
 *
 * Returned as a matrix rather than a list of records: `{ months, rows: [{ label, values }] }` states
 * each month label once instead of once per cell, which is several times cheaper over eighteen months
 * and reads as a table.
 */
export async function monthlyBreakdown(
  client: FireflyClient,
  params: { start: string; end: string; dimension: 'budget' | 'category'; type?: TypeFilter },
): Promise<MonthlyBreakdown> {
  const requestedType: TypeFilter = params.type ?? 'all';
  const effectiveType: TypeFilter = params.dimension === 'budget' ? 'withdrawal' : requestedType;
  const rows = await collectSplits(client, '/transactions', rangeQuery({ ...params, type: effectiveType }));

  const months = monthsBetween(params.start, params.end);
  const monthIndex = new Map(months.map((m, i) => [m, i]));

  // currency → label → month index → running total
  const byCurrency = new Map<string, Map<string, Money[]>>();
  for (const row of rows) {
    if (effectiveType !== 'all' && row.type.toLowerCase() !== effectiveType) continue;
    const index = monthIndex.get(row.date.slice(0, 7));
    if (index === undefined) continue;

    const label = (params.dimension === 'budget' ? row.budget_name : row.category_name) ?? '(none)';
    const labels = byCurrency.get(row.currency_code) ?? new Map<string, Money[]>();
    const cells = labels.get(label) ?? months.map(() => zeroMoney(2));
    cells[index] = addMoney(cells[index], parseMoney(row.amount));
    labels.set(label, cells);
    byCurrency.set(row.currency_code, labels);
  }

  const currencies = [...byCurrency.entries()]
    .map(([currency_code, labels]) => ({
      currency_code,
      rows: [...labels.entries()]
        .map(([label, cells]) => ({
          label,
          values: cells.map((cell) => formatMoney(cell, 2)),
          total: formatMoney(
            cells.reduce((a, b) => addMoney(a, b), zeroMoney(2)),
            2,
          ),
        }))
        .sort((a, b) => compareMoney(parseMoney(b.total), parseMoney(a.total)) || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.currency_code.localeCompare(b.currency_code));

  const result: MonthlyBreakdown = {
    start: params.start,
    end: params.end,
    dimension: params.dimension,
    months,
    multi_currency: currencies.length > 1,
    currencies,
  };
  if (params.dimension === 'budget' && requestedType !== 'withdrawal') result.note = BUDGET_NOTE;
  return result;
}

// ── Spending ratios ───────────────────────────────────────────────────────────

interface InsightEntry {
  id?: string;
  name?: string;
  difference?: string;
  currency_code?: string;
}

export interface SpendingRatios {
  start: string;
  end: string;
  currency_code: string;
  total: string;
  groups: Array<{
    name: string;
    budgets: string[];
    total: string;
    percentage: number;
    percentage_basis_points: number;
  }>;
  /** Names the caller asked for that match no budget — a typo must be visible, not silently zero. */
  unknown_budgets: string[];
}

/**
 * Splits expenses across caller-defined groups of budgets, so a 50/30/20-style rule can be checked
 * without the model doing the arithmetic itself.
 *
 * Sourced from `/insight/expense/budget`, which is expenses by construction — the transfers trap
 * cannot apply. Percentages use the largest-remainder method so they sum to exactly 100.00 rather
 * than 99.99, which reads as missing data.
 */
export async function spendingRatios(
  client: FireflyClient,
  params: { start: string; end: string; groups: Record<string, string[]>; currency_code?: string },
): Promise<SpendingRatios> {
  const query = { start: params.start, end: params.end };
  const [byBudget, noBudget] = await Promise.all([
    client.get<InsightEntry[]>('/insight/expense/budget', query),
    client.get<InsightEntry[]>('/insight/expense/no-budget', query),
  ]);

  const currency = params.currency_code ?? byBudget[0]?.currency_code ?? 'EUR';
  const relevant = byBudget.filter((e) => !e.currency_code || e.currency_code === currency);

  const normalise = (name: string): string => name.trim().toLowerCase();
  const spentByBudget = new Map<string, Money>();
  for (const entry of relevant) {
    if (!entry.name) continue;
    // Insight differences are negative for expenses; report magnitudes.
    spentByBudget.set(normalise(entry.name), absMoney(parseMoney(entry.difference ?? '0')));
  }

  const claimed = new Set<string>();
  const unknown: string[] = [];
  const groups: SpendingRatios['groups'] = [];
  const totals: Money[] = [];

  for (const [groupName, budgetNames] of Object.entries(params.groups)) {
    let sum = zeroMoney(2);
    for (const budgetName of budgetNames) {
      const key = normalise(budgetName);
      const spent = spentByBudget.get(key);
      if (spent === undefined) {
        unknown.push(budgetName.trim());
        continue;
      }
      claimed.add(key);
      sum = addMoney(sum, spent);
    }
    groups.push({
      name: groupName,
      budgets: budgetNames,
      total: formatMoney(sum, 2),
      percentage: 0,
      percentage_basis_points: 0,
    });
    totals.push(sum);
  }

  // Anything the caller did not place still exists; hiding it would make the shares describe a subset
  // while looking like they describe everything.
  const ungrouped = [...spentByBudget.entries()].filter(([key]) => !claimed.has(key));
  if (ungrouped.length > 0) {
    const sum = ungrouped.reduce((acc, [, value]) => addMoney(acc, value), zeroMoney(2));
    groups.push({
      name: '(ungrouped)',
      budgets: [],
      total: formatMoney(sum, 2),
      percentage: 0,
      percentage_basis_points: 0,
    });
    totals.push(sum);
  }

  const unbudgeted = noBudget
    .filter((e) => !e.currency_code || e.currency_code === currency)
    .reduce((acc, e) => addMoney(acc, absMoney(parseMoney(e.difference ?? '0'))), zeroMoney(2));
  if (unbudgeted.units !== 0n) {
    groups.push({
      name: '(no budget)',
      budgets: [],
      total: formatMoney(unbudgeted, 2),
      percentage: 0,
      percentage_basis_points: 0,
    });
    totals.push(unbudgeted);
  }

  const grandTotal = totals.reduce((a, b) => addMoney(a, b), zeroMoney(2));
  const points = largestRemainderPercentages(totals, grandTotal);
  for (const [i, group] of groups.entries()) {
    group.percentage_basis_points = points[i] ?? 0;
    group.percentage = Math.round((points[i] ?? 0) / 100);
  }

  return {
    start: params.start,
    end: params.end,
    currency_code: currency,
    total: formatMoney(grandTotal, 2),
    groups,
    unknown_budgets: unknown,
  };
}

// ── Uncategorised ─────────────────────────────────────────────────────────────

export interface UncategorisedResult {
  start: string;
  end: string;
  without_budget?: { count: number; total: string; currency_code: string };
  without_category?: { count: number; total: string; currency_code: string };
  transactions?: Array<Record<string, unknown>>;
  note?: string;
}

/**
 * Finds spending with no budget, no category, or neither.
 *
 * Counts come from pagination totals and insight endpoints, so the default answer is a handful of
 * numbers rather than hundreds of rows. Rows are only fetched when `include_transactions` is set, and
 * are returned in the compact projection.
 *
 * Firefly has a listing endpoint for "no budget" but none for "no category" — only an insight giving
 * the amount. The category count therefore comes from walking the period, which the page cap bounds.
 */
export async function findUncategorised(
  client: FireflyClient,
  params: {
    start: string;
    end: string;
    missing?: 'category' | 'budget' | 'both';
    include_transactions?: boolean;
    limit?: number;
  },
): Promise<UncategorisedResult> {
  const missing = params.missing ?? 'both';
  const query = { start: params.start, end: params.end };
  const result: UncategorisedResult = { start: params.start, end: params.end };

  if (missing === 'budget' || missing === 'both') {
    const [listing, insight] = await Promise.all([
      client.get<JsonApiListResponse>('/budgets/transactions-without-budget', { ...query, limit: 1 }),
      client.get<InsightEntry[]>('/insight/expense/no-budget', query),
    ]);
    const total = insight.reduce((acc, e) => addMoney(acc, absMoney(parseMoney(e.difference ?? '0'))), zeroMoney(2));
    result.without_budget = {
      count: listing.meta?.pagination?.total ?? 0,
      total: formatMoney(total, 2),
      currency_code: insight[0]?.currency_code ?? 'EUR',
    };
  }

  if (missing === 'category' || missing === 'both') {
    const insight = await client.get<InsightEntry[]>('/insight/expense/no-category', query);
    const total = insight.reduce((acc, e) => addMoney(acc, absMoney(parseMoney(e.difference ?? '0'))), zeroMoney(2));
    const rows = await collectSplits(client, '/transactions', { ...query, type: 'withdrawal' });
    result.without_category = {
      count: rows.filter((r) => r.category_id === null).length,
      total: formatMoney(total, 2),
      currency_code: insight[0]?.currency_code ?? 'EUR',
    };
    result.note =
      'Firefly III has no "transactions without category" listing endpoint, so that count comes from ' +
      'walking the period rather than from a pagination total, and is subject to the aggregate page cap.';
  }

  if (params.include_transactions) {
    const limit = Math.min(params.limit ?? 50, 200);
    const listing = await client.get<JsonApiListResponse>('/budgets/transactions-without-budget', {
      ...query,
      limit,
      page: 1,
    });
    result.transactions = projectUnwrappedList('transactions', unwrapList(listing), 'compact').data;
  }

  return result;
}

// ── Budget performance ────────────────────────────────────────────────────────

export interface BudgetPerformance {
  start: string;
  end: string;
  currency_code: string;
  total_spent: string;
  budgets: Array<{
    budget_id: string | null;
    name: string;
    limit: string | null;
    spent: string;
    remaining: string | null;
    percent_used: number | null;
    share_of_expenses: number;
    limits_counted: number;
    /** True when a counted limit only partly overlaps the requested period. */
    partial_limit_overlap: boolean;
  }>;
  note?: string;
}

/** Do two inclusive date ranges overlap at all? Compared as strings — ISO dates sort chronologically. */
const overlaps = (aStart: string, aEnd: string, bStart: string, bEnd: string): boolean =>
  aStart <= bEnd && bStart <= aEnd;

/** Is `[inner]` wholly inside `[outer]`? */
const contains = (outerStart: string, outerEnd: string, innerStart: string, innerEnd: string): boolean =>
  outerStart <= innerStart && innerEnd <= outerEnd;

/** Cap on budgets examined: each needs its own limits request, and 50 sequential calls is already slow. */
const MAX_BUDGETS = 50;

/**
 * Per budget over a period: limit, spent, remaining, percentage used, and share of total expenses.
 *
 * Limits that only partly overlap the requested period are counted whole and flagged rather than
 * pro-rated. Pro-rating invents a number — a monthly limit is not a daily allowance, and dividing it
 * by days would produce a figure with no counterpart in Firefly. Reporting the overlap lets the caller
 * decide, which is the honest division of labour.
 */
export async function budgetPerformance(
  client: FireflyClient,
  params: { start: string; end: string; currency_code?: string },
): Promise<BudgetPerformance> {
  const query = { start: params.start, end: params.end };

  const [budgetList, spentByBudget, noBudget] = await Promise.all([
    client.get<JsonApiListResponse>('/budgets', { ...query, limit: 100 }),
    client.get<InsightEntry[]>('/insight/expense/budget', query),
    client.get<InsightEntry[]>('/insight/expense/no-budget', query),
  ]);

  const budgets = unwrapList(budgetList).data;
  if (budgets.length > MAX_BUDGETS) {
    throw new Error(
      `This instance has ${budgets.length} budgets, over the ${MAX_BUDGETS} this tool examines: each needs ` +
        'its own limits request. Use get_transaction_aggregate grouped by budget instead.',
    );
  }

  const currency = params.currency_code ?? spentByBudget[0]?.currency_code ?? 'EUR';
  const spentById = new Map(
    spentByBudget
      .filter((e) => !e.currency_code || e.currency_code === currency)
      .map((e) => [e.id ?? '', absMoney(parseMoney(e.difference ?? '0'))]),
  );

  const rows: BudgetPerformance['budgets'] = [];
  const shares: Money[] = [];

  for (const budget of budgets) {
    const id = String(budget.id);
    const limitsResponse = await client.get<JsonApiListResponse>(`/budgets/${id}/limits`, query);
    const limits = unwrapList(limitsResponse).data.filter((limit) => {
      const limitStart = String(limit.start ?? '').slice(0, 10);
      const limitEnd = String(limit.end ?? '').slice(0, 10);
      return (
        (!limit.currency_code || limit.currency_code === currency) &&
        overlaps(limitStart, limitEnd, params.start, params.end)
      );
    });

    const limitTotal = limits.reduce((acc, l) => addMoney(acc, parseMoney(String(l.amount ?? '0'))), zeroMoney(2));
    const partial = limits.some(
      (l) => !contains(params.start, params.end, String(l.start ?? '').slice(0, 10), String(l.end ?? '').slice(0, 10)),
    );

    const spent = spentById.get(id) ?? zeroMoney(2);
    shares.push(spent);

    const hasLimit = limits.length > 0;
    rows.push({
      budget_id: id,
      name: String(budget.name ?? ''),
      limit: hasLimit ? formatMoney(limitTotal, 2) : null,
      spent: formatMoney(spent, 2),
      remaining: hasLimit ? formatMoney(subMoneyLocal(limitTotal, spent), 2) : null,
      percent_used: hasLimit ? basisPointsToPercent(basisPoints(spent, limitTotal)) : null,
      share_of_expenses: 0,
      limits_counted: limits.length,
      partial_limit_overlap: partial,
    });
  }

  // Unbudgeted spending is part of total expenses; leaving it out would make the shares add to less
  // than 100 with nothing to explain the gap.
  const unbudgeted = noBudget
    .filter((e) => !e.currency_code || e.currency_code === currency)
    .reduce((acc, e) => addMoney(acc, absMoney(parseMoney(e.difference ?? '0'))), zeroMoney(2));
  if (unbudgeted.units !== 0n) {
    shares.push(unbudgeted);
    rows.push({
      budget_id: null,
      name: '(no budget)',
      limit: null,
      spent: formatMoney(unbudgeted, 2),
      remaining: null,
      percent_used: null,
      share_of_expenses: 0,
      limits_counted: 0,
      partial_limit_overlap: false,
    });
  }

  const totalSpent = shares.reduce((a, b) => addMoney(a, b), zeroMoney(2));
  const points = largestRemainderPercentages(shares, totalSpent);
  for (const [i, row] of rows.entries()) row.share_of_expenses = Math.round((points[i] ?? 0) / 100);

  const result: BudgetPerformance = {
    start: params.start,
    end: params.end,
    currency_code: currency,
    total_spent: formatMoney(totalSpent, 2),
    budgets: rows.sort((a, b) => compareMoney(parseMoney(b.spent), parseMoney(a.spent))),
  };
  if (rows.some((r) => r.partial_limit_overlap)) {
    result.note =
      'Some budget limits only partly overlap the requested period. They are counted in full and ' +
      'flagged rather than pro-rated: a monthly limit is not a daily allowance, so a pro-rated figure ' +
      'would have no counterpart in Firefly III.';
  }
  return result;
}

/** Local subtraction helper — subMoney with a name that reads at the call site. */
function subMoneyLocal(a: Money, b: Money): Money {
  return addMoney(a, { units: -b.units, scale: b.scale });
}

const basisPointsToPercent = (points: number | null): number | null =>
  points === null ? null : Math.round(points / 100);

// ── Account balance history ───────────────────────────────────────────────────

interface ChartDataSet {
  label?: string;
  currency_code?: string;
  entries?: Record<string, number>;
}

export interface BalanceHistory {
  start: string;
  end: string;
  period: string;
  dates: string[];
  accounts: Array<{ label: string; currency_code: string; balances: number[] }>;
  /** Account ids the caller asked for that could not be matched to a chart series. */
  unmatched_account_ids?: string[];
  note: string;
}

/**
 * End-of-period balances per account, from `/chart/account/overview`.
 *
 * That endpoint takes no account filter, so `account_ids` is resolved to names and matched against the
 * series labels client-side. Two accounts sharing a name are indistinguishable here, which is why
 * anything unmatched is reported rather than quietly dropped.
 *
 * Balances come back as JSON numbers, not strings, and are passed through as such. That is the
 * endpoint's own shape, and no arithmetic is done on them here.
 */
export async function accountBalanceHistory(
  client: FireflyClient,
  params: { start: string; end: string; period?: string; account_ids?: string[]; preselected?: string },
): Promise<BalanceHistory> {
  const period = params.period ?? '1M';
  const query: QueryParams = { start: params.start, end: params.end, period };
  if (params.preselected) query.preselected = params.preselected;

  const chart = await client.get<ChartDataSet[]>('/chart/account/overview', query);

  let wanted: Set<string> | null = null;
  const unmatched: string[] = [];
  if (params.account_ids && params.account_ids.length > 0) {
    const accounts = unwrapList(await client.get<JsonApiListResponse>('/accounts', { limit: 100 })).data;
    const namesById = new Map(accounts.map((a) => [String(a.id), String(a.name ?? '')]));
    wanted = new Set();
    for (const id of params.account_ids) {
      const name = namesById.get(id);
      if (name) wanted.add(name);
      else unmatched.push(id);
    }
  }

  const series = chart.filter((set) => !wanted || (set.label !== undefined && wanted.has(set.label)));
  for (const id of params.account_ids ?? []) {
    const name = wanted ? [...wanted][params.account_ids?.indexOf(id) ?? -1] : undefined;
    if (name && !series.some((s) => s.label === name) && !unmatched.includes(id)) unmatched.push(id);
  }

  const dates = [...new Set(series.flatMap((set) => Object.keys(set.entries ?? {})))].sort();

  const result: BalanceHistory = {
    start: params.start,
    end: params.end,
    period,
    dates,
    accounts: series.map((set) => ({
      label: set.label ?? '(unnamed)',
      currency_code: set.currency_code ?? '',
      balances: dates.map((date) => set.entries?.[date] ?? 0),
    })),
    note:
      'Balances are returned as numbers by the Firefly III chart endpoint; no arithmetic is performed ' +
      'on them here. The endpoint takes no account filter, so account_ids are matched by name.',
  };
  if (unmatched.length > 0) result.unmatched_account_ids = unmatched;
  return result;
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerAggregateTools(server: McpServer, client: FireflyClient): void {
  const start = dateSchema.describe('Start date (YYYY-MM-DD), inclusive');
  const end = dateSchema.describe('End date (YYYY-MM-DD), inclusive');

  defineTool(
    server,
    'get_transaction_aggregate',
    {
      title: 'Aggregate Transactions',
      description:
        'Total transactions over a period without returning the transactions themselves. Group by ' +
        'category, budget, month, type, account or tag. Use this instead of get_transactions whenever ' +
        'the question is about totals: eighteen months of spending answers in a few hundred tokens. ' +
        'Amounts are summed exactly. Multiple currencies are reported separately, never added together.',
      inputSchema: {
        start,
        end,
        group_by: z
          .enum(['category', 'budget', 'month', 'type', 'source_account', 'destination_account', 'tag'])
          .describe('What to group the totals by'),
        type: z
          .enum(['withdrawal', 'deposit', 'transfer', 'all'])
          .optional()
          .default('all')
          .describe('Transaction type to include. Forced to withdrawal when grouping by budget.'),
        currency_code: z.string().optional().describe('Restrict to one currency, e.g. EUR'),
      },
      annotations: READ_ANNOTATIONS,
    },
    (args) => aggregateTransactions(client, args as Parameters<typeof aggregateTransactions>[1]),
  );

  defineTool(
    server,
    'get_monthly_breakdown',
    {
      title: 'Get Monthly Breakdown',
      description:
        'Month-by-month totals per budget or category, as a compact matrix: one list of months, then ' +
        'one row of values per budget. This is the cheapest shape for comparing periods, and the one a ' +
        '50/25/25 review needs. Amounts are decimal strings.',
      inputSchema: {
        start,
        end,
        dimension: z.enum(['budget', 'category']).describe('Break spending down by budget or by category'),
        type: z.enum(['withdrawal', 'deposit', 'transfer', 'all']).optional().default('all'),
      },
      annotations: READ_ANNOTATIONS,
    },
    (args) => monthlyBreakdown(client, args as Parameters<typeof monthlyBreakdown>[1]),
  );

  defineTool(
    server,
    'get_budget_performance',
    {
      title: 'Get Budget Performance',
      description:
        'For each budget over a period: the limit, what was spent, what remains, the percentage used, ' +
        'and its share of total expenses. Unbudgeted spending is included as its own row so the shares ' +
        'describe all expenses rather than a subset.',
      inputSchema: { start, end, currency_code: z.string().optional().describe('Restrict to one currency') },
      annotations: READ_ANNOTATIONS,
    },
    (args) => budgetPerformance(client, args as Parameters<typeof budgetPerformance>[1]),
  );

  defineTool(
    server,
    'get_spending_ratios',
    {
      title: 'Get Spending Ratios',
      description:
        'Split expenses across groups of budgets you define, as percentages that sum to exactly 100. ' +
        'Use it to check a rule such as 50/30/20 without doing the arithmetic yourself. Budget names ' +
        'that match nothing are reported back rather than silently counted as zero.',
      inputSchema: {
        start,
        end,
        groups: z
          .record(z.string(), z.array(z.string()))
          .describe('Group name to the budget names it contains, e.g. {"Needs": ["Fixes incompressibles"]}'),
        currency_code: z.string().optional().describe('Restrict to one currency'),
      },
      annotations: READ_ANNOTATIONS,
    },
    (args) => spendingRatios(client, args as Parameters<typeof spendingRatios>[1]),
  );

  defineTool(
    server,
    'get_account_balance_history',
    {
      title: 'Get Account Balance History',
      description:
        'End-of-period balances for accounts over a date range, as a dated matrix. Balances come from ' +
        "Firefly's chart endpoint as numbers. That endpoint takes no account filter, so account_ids are " +
        'matched by name and anything unmatched is reported.',
      inputSchema: {
        start,
        end,
        period: z.enum(['1D', '1W', '1M', '3M', '6M', '1Y']).optional().default('1M').describe('Sampling interval'),
        account_ids: z.array(z.string()).optional().describe('Restrict to these account IDs'),
        preselected: z
          .enum(['empty', 'all', 'assets', 'liabilities'])
          .optional()
          .describe('Which account family the chart should cover'),
      },
      annotations: READ_ANNOTATIONS,
    },
    (args) => accountBalanceHistory(client, args as Parameters<typeof accountBalanceHistory>[1]),
  );

  defineTool(
    server,
    'search_uncategorized',
    {
      title: 'Find Uncategorised Transactions',
      description:
        'Count and total the spending that has no budget, no category, or neither. Returns figures only ' +
        'unless include_transactions is set, in which case the rows come back in compact form and capped. ' +
        'Use this before a categorisation pass to see how much is actually unclassified.',
      inputSchema: {
        start,
        end,
        missing: z
          .enum(['category', 'budget', 'both'])
          .optional()
          .default('both')
          .describe('Which classification is missing'),
        include_transactions: z
          .boolean()
          .optional()
          .default(false)
          .describe('Also return the transactions themselves, in compact form'),
        limit: z.number().int().positive().max(200).optional().default(50).describe('Maximum rows to return'),
      },
      annotations: READ_ANNOTATIONS,
    },
    (args) => findUncategorised(client, args as Parameters<typeof findUncategorised>[1]),
  );
}
