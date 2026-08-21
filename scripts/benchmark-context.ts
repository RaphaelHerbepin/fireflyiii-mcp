#!/usr/bin/env tsx
/**
 * Measures what this server costs an assistant's context, and what the fork's two headline features
 * save.
 *
 * Two tables. The first is fixed overhead: what each preset's `tools/list` response costs before a
 * single call is made. The second is per-question cost, comparing the raw JSON:API payload, the
 * upstream flattened form, and this fork's projected and aggregated forms.
 *
 * Needs a live instance:
 *   FIREFLY_URL=… FIREFLY_TOKEN=… npx tsx scripts/benchmark-context.ts
 *
 * Output is markdown, printed to stdout for pasting into the README. It deliberately does not write
 * to the README itself: a script that edits documentation in CI is a script nobody reviews.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FireflyClient } from '../src/client.js';
import { projectUnwrappedList } from '../src/projection.js';
import { registerAggregateTools } from '../src/tools/aggregates.js';
import { registerTransactionTools } from '../src/tools/transactions.js';
import { type JsonApiListResponse, unwrapList } from '../src/transform.js';
import { inventory } from './print-tool-counts.js';

/** Rough token estimate. Four characters per token is the usual approximation for English JSON. */
const tokens = (text: string | number): number => Math.round((typeof text === 'number' ? text : text.length) / 4);

const pct = (value: number, base: number): string =>
  base === 0 ? '—' : `${(((value - base) / base) * 100).toFixed(1)}%`;

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function handlersFor(client: FireflyClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
    registerPrompt: () => {},
  } as unknown as McpServer;
  registerTransactionTools(server, client);
  registerAggregateTools(server, client);
  return handlers;
}

async function main(): Promise<number> {
  const url = process.env.FIREFLY_URL;
  const token = process.env.FIREFLY_TOKEN;
  if (!url || !token) {
    console.error('FIREFLY_URL and FIREFLY_TOKEN must be set. Point them at a seeded dev instance.');
    return 1;
  }
  const client = new FireflyClient(url, token);
  const handlers = handlersFor(client);

  // ── Fixed overhead per preset ───────────────────────────────────────────────
  const inv = inventory();
  console.log('### Context cost per preset\n');
  console.log('| Preset | Tools | `tools/list` |');
  console.log('|--------|-------|--------------|');
  for (const [preset, count] of Object.entries(inv.presets)) {
    console.log(`| \`${preset}\` | ${count} | ~${tokens(inv.toolsListBytes[preset]).toLocaleString('en')} tokens |`);
  }

  // ── Per-question cost ───────────────────────────────────────────────────────
  const scenarios: Array<{ label: string; args: Record<string, unknown> }> = [
    { label: 'One month of expenses', args: { start: '2025-01-01', end: '2025-01-31', type: 'withdrawal', limit: 50 } },
    { label: 'A full page of transactions', args: { limit: 100 } },
  ];

  console.log('\n### Cost of answering a question\n');
  console.log('| Question | Raw JSON:API | Upstream | `standard` | `compact` | Saved |');
  console.log('|----------|--------------|----------|------------|-----------|-------|');

  for (const { label, args } of scenarios) {
    const raw = await client.get<JsonApiListResponse>('/transactions', args as never);
    const rawSize = JSON.stringify(raw, null, 2).length;
    const upstream = JSON.stringify(unwrapList(raw), null, 2).length;

    const project = (fields: 'standard' | 'compact'): number =>
      JSON.stringify(projectUnwrappedList('transactions', unwrapList(raw), fields), null, 2).length;

    const std = project('standard');
    const compact = project('compact');
    console.log(
      `| ${label} | ~${tokens(rawSize).toLocaleString('en')} | ~${tokens(upstream).toLocaleString('en')} | ` +
        `~${tokens(std).toLocaleString('en')} | **~${tokens(compact).toLocaleString('en')}** | ` +
        `**${pct(compact, upstream)}** |`,
    );
  }

  // ── Aggregation ─────────────────────────────────────────────────────────────
  console.log('\n### Cost of a question aggregation answers\n');
  console.log('| Question | Reading the rows | Aggregating | Saved |');
  console.log('|----------|------------------|-------------|-------|');

  const range = { start: '2025-01-01', end: '2026-12-31' };

  const listed = await handlers.get('get_transactions')?.({ ...range, type: 'withdrawal', limit: 100 });
  const oneePage = listed?.content[0].text.length ?? 0;
  const totalPages = unwrapList(
    await client.get<JsonApiListResponse>('/transactions', { ...range, type: 'withdrawal', limit: 100 } as never),
  ).pagination?.totalPages;
  // Reading every row means paying for every page, not just the first.
  const wholeHistory = oneePage * (totalPages ?? 1);

  const aggregated = await handlers.get('get_transaction_aggregate')?.({ ...range, group_by: 'budget' });
  const aggregateSize = aggregated?.content[0].text.length ?? 0;

  console.log(
    `| Spending by budget, 18 months | ~${tokens(wholeHistory).toLocaleString('en')} (${totalPages} pages, compact) | ` +
      `**~${tokens(aggregateSize).toLocaleString('en')}** | **${pct(aggregateSize, wholeHistory)}** |`,
  );

  const monthly = await handlers.get('get_monthly_breakdown')?.({ ...range, dimension: 'budget' });
  console.log(
    `| Month-by-month per budget | ~${tokens(wholeHistory).toLocaleString('en')} (same rows, grouped by hand) | ` +
      `**~${tokens(monthly?.content[0].text.length ?? 0).toLocaleString('en')}** | ` +
      `**${pct(monthly?.content[0].text.length ?? 0, wholeHistory)}** |`,
  );

  console.log('\n_Token counts are estimates at four characters per token, measured against a live instance._');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
