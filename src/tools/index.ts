import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FireflyClient } from '../client.js';
import { registerAccountTools } from './accounts.js';
import { registerAggregateTools } from './aggregates.js';
import { registerAttachmentTools } from './attachments.js';
import { registerBillTools } from './bills.js';
import { registerBudgetTools } from './budgets.js';
import { registerCategoryTools } from './categories.js';
import { registerCurrencyTools } from './currencies.js';
import { registerExportTools } from './exports.js';
import { registerObjectGroupTools } from './object-groups.js';
import { registerPiggyBankTools } from './piggy-banks.js';
import { registerRecurringTools } from './recurring.js';
import { registerReportTools } from './reports.js';
import { registerRuleTools } from './rules.js';
import { registerSearchTools } from './search.js';
import { registerTransactionLinkTools } from './transaction-links.js';
import { registerTransactionTools } from './transactions.js';
import { registerWebhookTools } from './webhooks.js';

export const TOOL_GROUPS = [
  'accounts',
  'aggregates',
  'search',
  'transactions',
  'budgets',
  'categories',
  'bills',
  'piggy-banks',
  'reports',
  'rules',
  'recurring',
  'attachments',
  'currencies',
  'exports',
  'object-groups',
  'transaction-links',
  'webhooks',
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

export const PRESETS: Record<string, ToolGroup[]> = {
  minimal: ['search', 'accounts', 'transactions'],
  default: ['search', 'accounts', 'transactions', 'budgets', 'categories', 'bills', 'aggregates'],
  budgeting: ['search', 'accounts', 'transactions', 'budgets', 'categories', 'bills', 'piggy-banks', 'aggregates'],
  insights: ['search', 'accounts', 'transactions', 'categories', 'reports', 'aggregates'],
  automation: ['search', 'accounts', 'transactions', 'rules', 'recurring', 'webhooks'],
  full: [...TOOL_GROUPS],
};

export type PresetName = keyof typeof PRESETS;

export interface ToolFilterOptions {
  preset?: PresetName;
  groups?: ToolGroup[];
  readOnly?: boolean;
}

/**
 * Prompts that survive `--read-only`.
 *
 * An allow-list rather than a rule, and closed by default: a prompt not named here is dropped. All
 * three of today's prompts only read, but the proxy used to intercept `registerTool` alone, so a
 * future prompt that wrote would have passed straight through a read-only server. Adding a name here
 * is a deliberate decision; forgetting to is the safe failure.
 */
export const READ_ONLY_PROMPTS: ReadonlySet<string> = new Set([
  'account-transactions',
  'budget-transactions',
  'category-transactions',
]);

/**
 * Reads a tool's read-only status from its annotations.
 *
 * This used to be inferred from the tool's name — `get_`, `search_` or `test_` — which silently
 * dropped all nine `export_*` tools and `download_attachment` from every read-only server, despite
 * all ten carrying READ_ANNOTATIONS. Inferring a security property from a naming convention fails in
 * both directions: a read tool named unconventionally disappears, and a write tool named `get_…`
 * would sail through.
 *
 * A missing hint throws rather than defaulting. Defaulting to false hides a read tool; defaulting to
 * true exposes a write one. Both are silent, and one of them is a security bug — so neither is an
 * acceptable guess. `defineTool` requires annotations at the type level, so this can only fire for a
 * tool registered outside it.
 */
function isReadOnlyTool(name: string, config: unknown): boolean {
  const hint = (config as { annotations?: { readOnlyHint?: boolean } } | undefined)?.annotations?.readOnlyHint;
  if (typeof hint !== 'boolean') {
    throw new Error(
      `Tool "${name}" declares no annotations.readOnlyHint, so it cannot be classified for --read-only. ` +
        'Use one of READ_/WRITE_/UPDATE_/DELETE_ANNOTATIONS from src/tools/_annotations.ts.',
    );
  }
  return hint;
}

/** A registration handle that does nothing, returned in place of the SDK's when a tool is dropped. */
const INERT_REGISTRATION = {
  enable: () => {},
  disable: () => {},
  remove: () => {},
  update: () => {},
};

export function makeReadOnlyProxy(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') {
        return (name: string, config: unknown, handler: unknown) => {
          if (!isReadOnlyTool(name, config)) return INERT_REGISTRATION;
          return (target.registerTool as (n: string, c: unknown, h: unknown) => unknown)(name, config, handler);
        };
      }
      if (prop === 'registerPrompt') {
        return (name: string, config: unknown, handler: unknown) => {
          if (!READ_ONLY_PROMPTS.has(name)) return INERT_REGISTRATION;
          return (target.registerPrompt as (n: string, c: unknown, h: unknown) => unknown)(name, config, handler);
        };
      }
      if (prop === 'registerResource') {
        // No resources today. Closing the category costs one branch and removes a future gap.
        return () => INERT_REGISTRATION;
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

export function registerAllTools(server: McpServer, client: FireflyClient, options: ToolFilterOptions = {}): void {
  const { preset, groups, readOnly = false } = options;

  const activeGroups: Set<ToolGroup> = preset
    ? new Set(PRESETS[preset])
    : groups
      ? new Set(groups)
      : new Set(TOOL_GROUPS);

  const s = readOnly ? makeReadOnlyProxy(server) : server;

  if (activeGroups.has('accounts')) registerAccountTools(s, client);
  if (activeGroups.has('search')) registerSearchTools(s, client);
  if (activeGroups.has('webhooks')) registerWebhookTools(s, client);
  if (activeGroups.has('aggregates')) registerAggregateTools(s, client);
  if (activeGroups.has('transactions')) registerTransactionTools(s, client);
  if (activeGroups.has('budgets')) registerBudgetTools(s, client);
  if (activeGroups.has('categories')) registerCategoryTools(s, client);
  if (activeGroups.has('bills')) registerBillTools(s, client);
  if (activeGroups.has('piggy-banks')) registerPiggyBankTools(s, client);
  if (activeGroups.has('reports')) registerReportTools(s, client);
  if (activeGroups.has('rules')) registerRuleTools(s, client);
  if (activeGroups.has('recurring')) registerRecurringTools(s, client);
  if (activeGroups.has('attachments')) registerAttachmentTools(s, client);
  if (activeGroups.has('currencies')) registerCurrencyTools(s, client);
  if (activeGroups.has('exports')) registerExportTools(s, client);
  if (activeGroups.has('object-groups')) registerObjectGroupTools(s, client);
  if (activeGroups.has('transaction-links')) registerTransactionLinkTools(s, client);
}
