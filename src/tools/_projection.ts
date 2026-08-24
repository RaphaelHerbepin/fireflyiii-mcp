/**
 * Which read tools project their output, onto which entity, and with what default.
 *
 * A registry keyed by tool name has an obvious smell: it is the same name-based indirection that let
 * `isReadOnlyTool` silently drop the `export_*` tools for a year. The difference is that this one is
 * **total** — `src/tests/projection-registry.test.ts` fails the build if a read tool is registered
 * without an entry here. A partial convention drifts; an exhaustive one cannot.
 *
 * Not every read tool gets a `fields` parameter. The parameter costs roughly 60 tokens of schema in
 * every `tools/list` response, permanently, whether or not anyone uses it. Adding it to all 56 read
 * tools would spend ~3 400 tokens of fixed overhead to save nothing on endpoints that return twelve
 * currencies or four link types. It goes where payloads are actually large.
 */

import type { FieldPreset } from '../transform.js';

export interface ToolProjection {
  /** Key into FIELD_PRESETS. */
  entity: string;
  /** Whether the tool returns an UnwrappedList or a single UnwrappedSingle. */
  kind: 'list' | 'single';
  /**
   * Selector applied when the caller omits `fields`.
   *
   * Lists default to `compact`: a list is usually being scanned, and fifty full rows are ~41 000
   * tokens. Single-item reads default to `standard`: asking for one specific thing implies wanting
   * context, just not the sixteen SEPA fields.
   */
  default: FieldPreset;
}

/** Marks a read tool as deliberately unprojected. */
export const NO_PROJECTION = 'none' as const;

export const TOOL_PROJECTIONS: Record<string, ToolProjection | typeof NO_PROJECTION> = {
  // ── transactions ────────────────────────────────────────────────────────────
  get_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_transaction: { entity: 'transactions', kind: 'single', default: 'standard' },
  get_transaction_by_journal: { entity: 'transactions', kind: 'single', default: 'standard' },
  search_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_account_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_budget_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_category_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_bill_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_tag_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_transactions_without_budget: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_recurrence_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },

  // ── accounts ────────────────────────────────────────────────────────────────
  get_accounts: { entity: 'accounts', kind: 'list', default: 'compact' },
  get_account: { entity: 'accounts', kind: 'single', default: 'standard' },
  // Autocomplete rows are already minimal — id, label and a little context.
  search_entities: NO_PROJECTION,
  search_accounts: { entity: 'accounts', kind: 'list', default: 'compact' },

  // ── other large listings ────────────────────────────────────────────────────
  get_budgets: { entity: 'budgets', kind: 'list', default: 'compact' },
  get_budget: { entity: 'budgets', kind: 'single', default: 'standard' },
  get_budget_limit_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_categories: { entity: 'categories', kind: 'list', default: 'compact' },
  get_category: { entity: 'categories', kind: 'single', default: 'standard' },
  get_bills: { entity: 'bills', kind: 'list', default: 'compact' },
  get_bill: { entity: 'bills', kind: 'single', default: 'standard' },
  get_object_group_bills: { entity: 'bills', kind: 'list', default: 'compact' },
  get_piggy_banks: { entity: 'piggy_banks', kind: 'list', default: 'compact' },
  get_piggy_bank: { entity: 'piggy_banks', kind: 'single', default: 'standard' },
  get_account_piggy_banks: { entity: 'piggy_banks', kind: 'list', default: 'compact' },
  get_object_group_piggy_banks: { entity: 'piggy_banks', kind: 'list', default: 'compact' },
  get_tags: { entity: 'tags', kind: 'list', default: 'compact' },
  get_tag: { entity: 'tags', kind: 'single', default: 'standard' },
  get_rules: { entity: 'rules', kind: 'list', default: 'compact' },
  get_rule: { entity: 'rules', kind: 'single', default: 'standard' },
  get_rule_group_rules: { entity: 'rules', kind: 'list', default: 'compact' },
  get_recurring: { entity: 'recurrences', kind: 'list', default: 'compact' },
  get_recurrence: { entity: 'recurrences', kind: 'single', default: 'standard' },
  get_attachments: { entity: 'attachments', kind: 'list', default: 'compact' },
  get_attachments_for: { entity: 'attachments', kind: 'list', default: 'compact' },
  get_attachment: { entity: 'attachments', kind: 'single', default: 'standard' },

  // ── deliberately unprojected ────────────────────────────────────────────────
  // Small fixed-size payloads, or shapes that are not entity lists at all. A `fields` parameter here
  // would cost schema tokens in every tools/list response and save nothing.
  get_currencies: NO_PROJECTION,
  get_currency: NO_PROJECTION,
  get_budget_limits: NO_PROJECTION,
  get_all_budget_limits: NO_PROJECTION,
  get_budget_limit: NO_PROJECTION,
  get_available_budgets: NO_PROJECTION,
  get_available_budget: NO_PROJECTION,
  get_object_groups: NO_PROJECTION,
  get_object_group: NO_PROJECTION,
  get_rule_groups: NO_PROJECTION,
  get_bill_rules: NO_PROJECTION,
  get_transaction_piggy_bank_events: NO_PROJECTION,
  get_rule_group: NO_PROJECTION,
  get_link_types: NO_PROJECTION,
  get_link_type: NO_PROJECTION,
  get_all_transaction_links: NO_PROJECTION,
  get_link_type_transactions: { entity: 'transactions', kind: 'list', default: 'compact' },
  get_transaction_links: NO_PROJECTION,
  get_transaction_link: NO_PROJECTION,
  get_piggy_bank_events: NO_PROJECTION,
  get_summary: NO_PROJECTION,
  get_about: NO_PROJECTION,
  get_exchange_rate: NO_PROJECTION,
  get_exchange_rates: NO_PROJECTION,
  get_exchange_rate_by_id: NO_PROJECTION,
  get_exchange_rates_for_pair: NO_PROJECTION,
  get_exchange_rate_on_date: NO_PROJECTION,
  get_primary_currency: NO_PROJECTION,
  // The shape depends on which sub-resource was asked for, so no single entity applies.
  get_currency_related: NO_PROJECTION,

  // Insight and chart endpoints return purpose-built aggregate shapes, not entity records.
  get_insight_expenses: NO_PROJECTION,
  get_insight_income: NO_PROJECTION,
  get_insight_expenses_no_bill: NO_PROJECTION,
  get_insight_expenses_no_budget: NO_PROJECTION,
  get_insight_expenses_no_category: NO_PROJECTION,
  get_insight_expenses_no_tag: NO_PROJECTION,
  get_insight_income_no_category: NO_PROJECTION,
  get_insight_income_no_tag: NO_PROJECTION,
  get_insight_transfer_no_category: NO_PROJECTION,
  get_insight_transfer_no_tag: NO_PROJECTION,
  get_insight_expenses_by_bill: NO_PROJECTION,
  get_insight_expenses_by_budget: NO_PROJECTION,
  get_insight_expenses_by_tag: NO_PROJECTION,
  get_insight_expenses_by_asset: NO_PROJECTION,
  get_insight_expenses_by_expense_account: NO_PROJECTION,
  get_insight_expenses_total: NO_PROJECTION,
  get_insight_income_by_revenue: NO_PROJECTION,
  get_insight_income_by_tag: NO_PROJECTION,
  get_insight_income_by_asset: NO_PROJECTION,
  get_insight_income_total: NO_PROJECTION,
  get_insight_transfers_by_category: NO_PROJECTION,
  get_insight_transfers_by_tag: NO_PROJECTION,
  get_insight_transfers_by_asset: NO_PROJECTION,
  get_insight_transfers_total: NO_PROJECTION,
  get_account_overview_chart: NO_PROJECTION,
  get_balance_chart: NO_PROJECTION,
  get_budget_chart: NO_PROJECTION,
  get_category_chart: NO_PROJECTION,

  // Aggregate tools return purpose-built totals, already as small as the answer can be. Projecting
  // them would mean projecting a shape that has no entity behind it.
  get_transaction_aggregate: NO_PROJECTION,
  get_monthly_breakdown: NO_PROJECTION,
  get_budget_performance: NO_PROJECTION,
  get_spending_ratios: NO_PROJECTION,
  get_account_balance_history: NO_PROJECTION,
  // search_uncategorized projects its own rows internally when include_transactions is set, so a
  // second projection here would apply the default over a already-compact list.
  search_uncategorized: NO_PROJECTION,

  // Webhook records are small and their fields all matter when debugging a delivery.
  get_webhooks: NO_PROJECTION,
  get_webhook: NO_PROJECTION,
  get_webhook_messages: NO_PROJECTION,
  get_webhook_message: NO_PROJECTION,
  get_webhook_message_attempts: NO_PROJECTION,
  get_webhook_message_attempt: NO_PROJECTION,

  // Administration records: small, and every field matters when diagnosing access problems.
  get_current_user: NO_PROJECTION,
  get_users: NO_PROJECTION,
  get_user: NO_PROJECTION,
  get_user_groups: NO_PROJECTION,
  get_user_group: NO_PROJECTION,
  get_configuration: NO_PROJECTION,
  get_configuration_value: NO_PROJECTION,
  get_preferences: NO_PROJECTION,
  get_preference: NO_PROJECTION,

  // Raw CSV text and binary content: nothing to project.
  export_transactions: NO_PROJECTION,
  export_accounts: NO_PROJECTION,
  export_bills: NO_PROJECTION,
  export_budgets: NO_PROJECTION,
  export_categories: NO_PROJECTION,
  export_tags: NO_PROJECTION,
  export_recurring: NO_PROJECTION,
  export_rules: NO_PROJECTION,
  export_piggy_banks: NO_PROJECTION,
  download_attachment: NO_PROJECTION,

  // Rule dry-runs return transactions, but as a preview of what a rule would touch; the caller wants
  // to see the whole record, and the result set is bounded by the rule itself.
  test_rule: NO_PROJECTION,
  test_rule_group: NO_PROJECTION,
};
