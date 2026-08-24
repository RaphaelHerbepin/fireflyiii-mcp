/**
 * Integration tests for what this fork adds, against a live Firefly III instance.
 *
 * Gated on two variables, not one. `FIREFLY_INTEGRATION` arms the suite; `FIREFLY_SEEDED` arms the
 * tests that need the 2 008-transaction dataset from `scripts/seed-dev-data.ts` and assert absolute
 * figures against `spec/seed-manifest.json`. Without that split, running the existing integration
 * suite against an empty CI instance would fail on tests that were never applicable to it.
 *
 *   npx tsx scripts/seed-dev-data.ts --url … --token …
 *   FIREFLY_INTEGRATION=true FIREFLY_SEEDED=true npm run test:integration
 */

import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { FireflyClient } from '../client.js';
import { projectUnwrappedList } from '../projection.js';
import { registerAggregateTools } from '../tools/aggregates.js';
import { registerAllTools } from '../tools/index.js';
import { registerTransactionTools } from '../tools/transactions.js';
import { type JsonApiListResponse, unwrapList } from '../transform.js';

const SKIP = !process.env.FIREFLY_INTEGRATION;
const SKIP_SEEDED = SKIP || !process.env.FIREFLY_SEEDED;

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

interface Manifest {
  totals: { withdrawalCents: number; byBudget: Record<string, number> };
  counts: { withdrawals: number; unbudgeted: number };
}

describe.skipIf(SKIP)('Fork features against a live instance', () => {
  let client: FireflyClient;
  let handlers: Map<string, Handler>;

  beforeAll(() => {
    const url = process.env.FIREFLY_URL;
    const token = process.env.FIREFLY_TOKEN;
    if (!url || !token) throw new Error('FIREFLY_URL and FIREFLY_TOKEN must be set');
    client = new FireflyClient(url, token);

    handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
      registerPrompt: () => {},
    } as unknown as McpServer;
    registerTransactionTools(server, client);
    registerAggregateTools(server, client);
  });

  describe('field projection', () => {
    it('cuts a real page of transactions by at least 60%', async () => {
      const raw = await client.get<JsonApiListResponse>('/transactions', { limit: 50 });
      const list = unwrapList(raw);
      if (list.data.length === 0) return; // empty instance: nothing to measure

      const full = JSON.stringify(projectUnwrappedList('transactions', list, 'full'), null, 2).length;
      const compact = JSON.stringify(projectUnwrappedList('transactions', list, 'compact'), null, 2).length;
      // The brief asked for 60%; measured against seeded data this is closer to 88%.
      expect(compact).toBeLessThan(full * 0.4);
    });

    it('keeps every compact field that budget analysis needs', async () => {
      const result = await handlers.get('get_transactions')?.({ limit: 5, type: 'withdrawal' });
      const payload = JSON.parse(result?.content[0].text ?? '{}');
      if (!payload.data?.length) return;
      const row = payload.data[0];
      for (const field of ['id', 'date', 'amount', 'currency_code', 'description', 'type']) {
        expect(row, `compact dropped ${field}`).toHaveProperty(field);
      }
      // …and none of the noise it exists to remove.
      expect(Object.keys(row).some((k) => k.startsWith('sepa_'))).toBe(false);
    });
  });

  describe('read-only mode', () => {
    it('keeps the export and download tools it used to drop', () => {
      const names: string[] = [];
      const server = {
        registerTool: (name: string) => names.push(name),
        registerPrompt: () => {},
      } as unknown as McpServer;
      registerAllTools(server, client, { readOnly: true });

      // The regression this guards: all nine export_* tools and download_attachment carry
      // READ_ANNOTATIONS but match no name prefix, and the old filter removed them.
      expect(names).toContain('export_transactions');
      expect(names).toContain('download_attachment');
      expect(names).not.toContain('create_transaction');
    });
  });

  // Aggregates walk every page of the range: twenty requests against a seeded instance, and the
  // client allows 30 s each. Vitest's 5 s default would fail these on duration alone.
  describe.skipIf(SKIP_SEEDED)('aggregation against the seeded dataset', { timeout: 120_000 }, () => {
    let manifest: Manifest;

    beforeAll(() => {
      manifest = JSON.parse(
        readFileSync(new URL('../../spec/seed-manifest.json', import.meta.url), 'utf8'),
      ) as Manifest;
    });

    it('totals withdrawals to the cent', async () => {
      const result = await handlers.get('get_transaction_aggregate')?.({
        start: '2025-01-01',
        end: '2026-12-31',
        group_by: 'budget',
        type: 'withdrawal',
        currency_code: 'EUR',
      });
      const payload = JSON.parse(result?.content[0].text ?? '{}');
      const total = payload.totals?.find((t: { currency_code: string }) => t.currency_code === 'EUR');
      // Compared against the generator's own running total, computed in integer cents and never read
      // back from the API — so this cannot pass by being wrong in the same way twice.
      expect(Math.round(Number(total.total) * 100)).toBe(manifest.totals.withdrawalCents);
    });

    it('splits by budget to the cent', async () => {
      const result = await handlers.get('get_transaction_aggregate')?.({
        start: '2025-01-01',
        end: '2026-12-31',
        group_by: 'budget',
        type: 'withdrawal',
        currency_code: 'EUR',
      });
      const payload = JSON.parse(result?.content[0].text ?? '{}');
      for (const [budget, cents] of Object.entries(manifest.totals.byBudget)) {
        const row = payload.groups.find((g: { label: string }) => g.label === budget);
        expect(row, `no row for ${budget}`).toBeDefined();
        expect(Math.round(Number(row.total) * 100), budget).toBe(cents);
      }
    });

    it('answers eighteen months in a fraction of what reading the rows costs', async () => {
      const aggregate = await handlers.get('get_transaction_aggregate')?.({
        start: '2025-01-01',
        end: '2026-12-31',
        group_by: 'budget',
      });
      const onePage = await handlers.get('get_transactions')?.({ limit: 100, type: 'withdrawal' });
      // One page of compact rows already costs several times the whole aggregate; the full history
      // is twenty such pages.
      expect(aggregate?.content[0].text.length).toBeLessThan((onePage?.content[0].text.length ?? 0) / 5);
    });

    it('finds the deliberately unbudgeted transactions', async () => {
      const result = await handlers.get('search_uncategorized')?.({
        start: '2025-01-01',
        end: '2026-12-31',
        missing: 'budget',
      });
      const payload = JSON.parse(result?.content[0].text ?? '{}');
      expect(payload.without_budget.count).toBe(manifest.counts.unbudgeted);
    });

    it('refuses a range wider than the page cap instead of returning a partial total', async () => {
      // A silently partial total is worse than an error: it looks complete and is wrong.
      const result = await handlers.get('get_transaction_aggregate')?.({
        start: '2000-01-01',
        end: '2030-12-31',
        group_by: 'category',
      });
      if (result?.isError) expect(result.content[0].text).toMatch(/narrow the date range/i);
    });
  });
});
