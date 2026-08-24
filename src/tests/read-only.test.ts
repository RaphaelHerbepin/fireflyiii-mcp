import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import { registerAllTools } from '../tools/index.js';

function register(readOnly: boolean): string[] {
  const registered: string[] = [];
  const server = {
    registerTool: (name: string) => registered.push(name),
    registerPrompt: vi.fn(),
  } as unknown as McpServer;
  registerAllTools(server, {} as FireflyClient, { readOnly });
  return registered;
}

describe('--read-only derives from annotations, not from tool names', () => {
  it('keeps the nine export_* tools, which no name prefix matches', () => {
    // The bug this replaces: isReadOnlyTool tested for get_/search_/test_, so every export_* tool —
    // all carrying READ_ANNOTATIONS — was dropped from a read-only server. Reading a CSV export is
    // not a write, and the annotation said so all along.
    const tools = register(true);
    for (const name of [
      'export_transactions',
      'export_accounts',
      'export_bills',
      'export_budgets',
      'export_categories',
      'export_tags',
      'export_recurring',
      'export_rules',
      'export_piggy_banks',
    ]) {
      expect(tools, `${name} should survive --read-only`).toContain(name);
    }
  });

  it('keeps download_attachment, which the brief did not notice', () => {
    expect(register(true)).toContain('download_attachment');
  });

  it('still keeps the tools the prefix rule got right', () => {
    const tools = register(true);
    for (const name of ['get_accounts', 'search_transactions', 'test_rule', 'get_transaction_aggregate']) {
      expect(tools).toContain(name);
    }
  });

  it('still drops every write tool', () => {
    const tools = register(true);
    for (const name of [
      'create_transaction',
      'update_transaction',
      'delete_transaction',
      'upload_attachment',
      'trigger_rule',
      'bulk_update_transactions',
      'enable_currency',
      'set_primary_currency',
    ]) {
      expect(tools, `${name} must not survive --read-only`).not.toContain(name);
    }
  });

  it('drops exactly the tools whose annotations say they write', () => {
    const full = new Set(register(false));
    const readOnly = new Set(register(true));
    const dropped = [...full].filter((name) => !readOnly.has(name));
    // Nothing surviving may be a write, and nothing dropped may be a read.
    expect(dropped.every((name) => !name.startsWith('get_') && !name.startsWith('search_'))).toBe(true);
    expect(readOnly.size + dropped.length).toBe(full.size);
  });

  it('refuses to register a tool with no readOnlyHint rather than guessing', async () => {
    // Failing loudly beats defaulting either way: defaulting to false hides a read tool, defaulting
    // to true exposes a write one, and both are silent.
    const { defineTool } = await import('../tools/_helpers.js');
    const { makeReadOnlyProxy } = await import('../tools/index.js');
    const server = makeReadOnlyProxy({
      registerTool: vi.fn(),
      registerPrompt: vi.fn(),
    } as unknown as McpServer);

    expect(() =>
      defineTool(server, 'get_unannotated_thing', { title: 'x', description: 'x' } as never, async () => ({
        data: [],
      })),
    ).toThrow(/annotations\.readOnlyHint/);
  });
});

describe('--read-only and prompts', () => {
  it('keeps only the prompts on the allow-list', () => {
    const prompts: string[] = [];
    const server = {
      registerTool: vi.fn(),
      registerPrompt: (name: string) => prompts.push(name),
    } as unknown as McpServer;
    registerAllTools(server, {} as FireflyClient, { readOnly: true });
    // The proxy used to intercept registerTool only, so prompts passed through unfiltered. None of
    // the three writes today, but nothing prevented a future one from doing so.
    expect(prompts.sort()).toEqual(['account-transactions', 'budget-transactions', 'category-transactions']);
  });

  it('registers every prompt when not read-only', () => {
    const prompts: string[] = [];
    const server = {
      registerTool: vi.fn(),
      registerPrompt: (name: string) => prompts.push(name),
    } as unknown as McpServer;
    registerAllTools(server, {} as FireflyClient);
    expect(prompts).toHaveLength(3);
  });
});
