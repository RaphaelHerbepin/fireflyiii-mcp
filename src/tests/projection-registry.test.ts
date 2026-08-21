import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import { FIELD_PRESETS } from '../projection.js';
import { NO_PROJECTION, TOOL_PROJECTIONS } from '../tools/_projection.js';
import { registerAllTools } from '../tools/index.js';

/** Every tool the server registers, with the config it was registered with. */
function registeredTools(): Array<{ name: string; config: { inputSchema?: Record<string, unknown> } }> {
  const tools: Array<{ name: string; config: { inputSchema?: Record<string, unknown> } }> = [];
  const server = {
    registerTool: (name: string, config: { inputSchema?: Record<string, unknown> }) => tools.push({ name, config }),
    registerPrompt: vi.fn(),
  } as unknown as McpServer;
  registerAllTools(server, {} as FireflyClient);
  return tools;
}

/** Prefixes that identify a read tool. Kept in sync with the read-only filter. */
const READ_PREFIXES = ['get_', 'search_', 'test_', 'export_', 'download_'];
const isRead = (name: string): boolean => READ_PREFIXES.some((p) => name.startsWith(p));

describe('TOOL_PROJECTIONS is exhaustive', () => {
  // This is the test that makes a name-keyed registry safe. `isReadOnlyTool` used the same kind of
  // name-based lookup and silently dropped ten tools for a year, because nothing checked it was
  // complete. A partial convention drifts; an exhaustive one cannot.
  it('has an entry for every read tool the server registers', () => {
    const missing = registeredTools()
      .map((t) => t.name)
      .filter(isRead)
      .filter((name) => !(name in TOOL_PROJECTIONS));
    expect(
      missing,
      `Add these to src/tools/_projection.ts — either a projection or NO_PROJECTION:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has no entry for a tool that is not registered', () => {
    const names = new Set(registeredTools().map((t) => t.name));
    const stale = Object.keys(TOOL_PROJECTIONS).filter((name) => !names.has(name));
    expect(stale, `Remove these stale entries from src/tools/_projection.ts:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('has no entry for a write tool', () => {
    const writeEntries = Object.keys(TOOL_PROJECTIONS).filter((name) => !isRead(name));
    expect(writeEntries).toEqual([]);
  });

  it('only names entities that FIELD_PRESETS defines', () => {
    for (const [tool, projection] of Object.entries(TOOL_PROJECTIONS)) {
      if (projection === NO_PROJECTION) continue;
      expect(Object.keys(FIELD_PRESETS), `${tool} names unknown entity '${projection.entity}'`).toContain(
        projection.entity,
      );
    }
  });

  it('defaults lists to compact and single reads to standard', () => {
    for (const [tool, projection] of Object.entries(TOOL_PROJECTIONS)) {
      if (projection === NO_PROJECTION) continue;
      const expected = projection.kind === 'list' ? 'compact' : 'standard';
      expect(projection.default, `${tool} (${projection.kind})`).toBe(expected);
    }
  });
});

describe('the fields parameter', () => {
  it('is injected into every projected tool and no other', () => {
    for (const { name, config } of registeredTools()) {
      const projection = TOOL_PROJECTIONS[name];
      const hasFields = Boolean(config.inputSchema && 'fields' in config.inputSchema);
      const shouldHave = Boolean(projection && projection !== NO_PROJECTION);
      expect(hasFields, `${name}: fields ${hasFields ? 'present' : 'absent'}, expected the opposite`).toBe(shouldHave);
    }
  });

  it('does not collide with the existing `field` parameter on search_accounts', () => {
    // search_accounts already takes `field` (all|iban|name|number|id). Two near-identical parameter
    // names on one tool is a real confusion hazard, so both must be present and clearly described.
    const tool = registeredTools().find((t) => t.name === 'search_accounts');
    expect(tool?.config.inputSchema).toHaveProperty('field');
    expect(tool?.config.inputSchema).toHaveProperty('fields');
  });
});

describe('defineTool applies projection end to end', () => {
  /** Registers the transaction tools against a mock server and returns the handler map. */
  async function callTool(name: string, args: Record<string, unknown>, fixture: unknown) {
    const { createMockServer } = await import('./_helpers.js');
    const { registerTransactionTools } = await import('../tools/transactions.js');
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockResolvedValueOnce(fixture) } as unknown as FireflyClient;
    registerTransactionTools(server, client);
    const result = (await handlers.get(name)?.(args)) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text);
  }

  it('returns compact rows by default from get_transactions', async () => {
    const { transactionListFixture } = await import('./fixtures/transactions.js');
    const payload = await callTool('get_transactions', {}, transactionListFixture);
    const row = payload.data[0];
    expect(row).toHaveProperty('amount');
    expect(row).toHaveProperty('description');
    expect(row).not.toHaveProperty('sepa_ct_id');
    expect(row).not.toHaveProperty('pc_amount');
    expect(Object.keys(row).length).toBeLessThanOrEqual(11);
  });

  it("returns everything for fields: 'full'", async () => {
    const { transactionListFixture, SPLIT_FIELD_COUNT } = await import('./fixtures/transactions.js');
    const payload = await callTool('get_transactions', { fields: 'full' }, transactionListFixture);
    const splits = payload.data[0].transactions as Array<Record<string, unknown>>;
    expect(Object.keys(splits[0])).toHaveLength(SPLIT_FIELD_COUNT);
  });

  it('honours an explicit field list, always including id', async () => {
    const { transactionListFixture } = await import('./fixtures/transactions.js');
    const payload = await callTool('get_transactions', { fields: ['description'] }, transactionListFixture);
    expect(Object.keys(payload.data[0]).sort()).toEqual(['description', 'id']);
  });

  it('reports an unknown preset as a tool error rather than throwing', async () => {
    const { createMockServer } = await import('./_helpers.js');
    const { registerTransactionTools } = await import('../tools/transactions.js');
    const { transactionListFixture } = await import('./fixtures/transactions.js');
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockResolvedValueOnce(transactionListFixture) } as unknown as FireflyClient;
    registerTransactionTools(server, client);
    const result = (await handlers.get('get_transactions')?.({ fields: 'verbose' })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/compact.*standard.*full/);
  });

  it('never passes fields through to the fetch function', async () => {
    const { createMockServer } = await import('./_helpers.js');
    const { registerTransactionTools } = await import('../tools/transactions.js');
    const { transactionListFixture } = await import('./fixtures/transactions.js');
    const { server, handlers } = createMockServer();
    const get = vi.fn().mockResolvedValueOnce(transactionListFixture);
    registerTransactionTools(server, { get } as unknown as FireflyClient);
    await handlers.get('get_transactions')?.({ fields: 'compact', limit: 10 });
    // fields is a presentation concern; it must not reach the query string.
    const query = get.mock.calls[0][1] as Record<string, unknown>;
    expect(query).not.toHaveProperty('fields');
    expect(query).toHaveProperty('limit', 10);
  });

  it('keeps a single-item read unwrapped and defaults it to standard', async () => {
    const { transactionSingleFixture } = await import('./fixtures/transactions.js');
    const payload = await callTool('get_transaction', { id: '101' }, transactionSingleFixture);
    expect(payload.id).toBe('101');
    // standard adds tags/notes/reconciliation on top of compact, but not the SEPA block.
    expect(payload).toHaveProperty('reconciled');
    expect(payload).not.toHaveProperty('sepa_cc');
  });

  it('leaves an unprojected tool untouched', async () => {
    const { createMockServer } = await import('./_helpers.js');
    const { registerExportTools } = await import('../tools/exports.js');
    const { server, handlers } = createMockServer();
    const client = { getText: vi.fn().mockResolvedValueOnce('id,amount\n1,45.00\n') } as unknown as FireflyClient;
    registerExportTools(server, client);
    const result = (await handlers.get('export_transactions')?.({})) as { content: Array<{ text: string }> };
    // Raw CSV, passed through verbatim rather than JSON-serialised.
    expect(result.content[0].text).toBe('id,amount\n1,45.00\n');
  });
});

describe('the fields collision guard', () => {
  it('refuses at registration time to shadow a tool-declared fields parameter', async () => {
    const { z } = await import('zod');
    const { defineTool } = await import('../tools/_helpers.js');
    const { READ_ANNOTATIONS } = await import('../tools/_annotations.js');
    const { createMockServer } = await import('./_helpers.js');
    const { server } = createMockServer();

    expect(() =>
      defineTool(
        server,
        'get_transactions',
        { inputSchema: { fields: z.string() }, annotations: READ_ANNOTATIONS },
        async () => ({ data: [] }),
      ),
    ).toThrow(/collides with the projection parameter/);
  });
});
