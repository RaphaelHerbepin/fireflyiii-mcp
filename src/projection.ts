/**
 * Entity-aware field projection.
 *
 * `transform.ts` provides the flat primitives ({@link pickFields}); this module knows what a
 * transaction, an account or a bill is, and which of their fields are worth returning by default.
 *
 * Why this matters concretely: measured against a live Firefly III 6.5.5 instance, one transaction
 * serialises to roughly 3 300 characters — about 830 tokens — because each split carries 77 fields, of
 * which sixteen are `sepa_*`, five are `pc_*` and five more restate the amount in the administration's
 * primary currency. Fifty transactions cost ~41 000 tokens. A budget analysis uses about ten of those
 * fields. Projection is what turns "list my January transactions" from impossible into routine.
 */

import { debugLog } from './tools/_helpers.js';
import { type FieldPreset, type FieldSelector, pickFields, pickFieldsList, type UnwrappedList } from './transform.js';

export class UnknownFieldPresetError extends Error {
  constructor(preset: string) {
    super(`Unknown field preset "${preset}". Valid presets are: compact, standard, full.`);
    this.name = 'UnknownFieldPresetError';
  }
}

export interface EntityProjection {
  presets: Record<FieldPreset, string[] | '*'>;
  /**
   * Key on the unwrapped object holding the array that carries the real payload.
   *
   * Only transactions need this. In Firefly III a transaction is a GROUP: its `attributes` hold just
   * `created_at`, `updated_at`, `user`, `user_group`, `group_title` and a `transactions` array, and
   * every financial field lives on the splits inside. Projecting the root keys would return an object
   * with no money in it.
   */
  splitKey?: string;
  /** Root keys kept alongside the projected splits, beyond `id`. */
  rootKeep?: string[];
}

/**
 * Fields retained per preset, per entity.
 *
 * `compact` is what a budget analysis actually reads. `standard` adds context worth having when you
 * asked for one specific thing. `full` is everything, for the rare case that needs it.
 *
 * Two families are excluded from both `compact` and `standard` everywhere: `sepa_*` (sixteen fields
 * that are empty on virtually every transaction) and `pc_*` / `primary_currency_*` (recent additions
 * that restate the amount in the administration's primary currency). `latitude`, `longitude`,
 * `zoom_level` and `import_hash_v2` are `full`-only for the same reason.
 */
export const FIELD_PRESETS: Record<string, EntityProjection> = {
  transactions: {
    splitKey: 'transactions',
    rootKeep: ['group_title'],
    presets: {
      compact: [
        'date',
        'amount',
        'currency_code',
        'description',
        'type',
        'category_name',
        'budget_name',
        'source_name',
        'destination_name',
      ],
      standard: [
        'date',
        'amount',
        'currency_code',
        'description',
        'type',
        'category_name',
        'budget_name',
        'source_name',
        'destination_name',
        'tags',
        'bill_name',
        'notes',
        'reconciled',
        'source_type',
        'destination_type',
        'foreign_amount',
        'foreign_currency_code',
        'transaction_journal_id',
      ],
      full: '*',
    },
  },

  accounts: {
    presets: {
      compact: ['name', 'type', 'current_balance', 'currency_code', 'active'],
      standard: [
        'name',
        'type',
        'current_balance',
        'currency_code',
        'active',
        'account_role',
        'iban',
        'account_number',
        'include_net_worth',
        'current_balance_date',
        'notes',
      ],
      full: '*',
    },
  },

  budgets: {
    presets: {
      compact: ['name', 'active', 'auto_budget_type', 'auto_budget_amount', 'currency_code'],
      standard: [
        'name',
        'active',
        'auto_budget_type',
        'auto_budget_amount',
        'currency_code',
        'auto_budget_period',
        'order',
        'notes',
        'spent',
      ],
      full: '*',
    },
  },

  categories: {
    presets: {
      compact: ['name'],
      standard: ['name', 'notes', 'spent', 'earned'],
      full: '*',
    },
  },

  bills: {
    presets: {
      compact: ['name', 'active', 'amount_min', 'amount_max', 'currency_code', 'repeat_freq', 'date'],
      standard: [
        'name',
        'active',
        'amount_min',
        'amount_max',
        'currency_code',
        'repeat_freq',
        'date',
        'end_date',
        'skip',
        'notes',
        'object_group_title',
        'next_expected_match',
      ],
      full: '*',
    },
  },

  piggy_banks: {
    presets: {
      compact: ['name', 'target_amount', 'current_amount', 'percentage', 'currency_code', 'active'],
      standard: [
        'name',
        'target_amount',
        'current_amount',
        'percentage',
        'currency_code',
        'active',
        'left_to_save',
        'save_per_month',
        'target_date',
        'start_date',
        'notes',
        'object_group_title',
        'accounts',
      ],
      full: '*',
    },
  },

  rules: {
    presets: {
      compact: ['title', 'active', 'rule_group_title', 'order'],
      standard: ['title', 'active', 'rule_group_title', 'order', 'description', 'trigger', 'strict', 'stop_processing'],
      full: '*',
    },
  },

  recurrences: {
    presets: {
      compact: ['title', 'type', 'active', 'first_date', 'latest_date', 'repeat_until'],
      standard: [
        'title',
        'type',
        'active',
        'first_date',
        'latest_date',
        'repeat_until',
        'description',
        'apply_rules',
        'nr_of_repetitions',
        'notes',
      ],
      full: '*',
    },
  },

  tags: {
    presets: {
      compact: ['tag', 'date'],
      standard: ['tag', 'date', 'description'],
      full: '*',
    },
  },

  attachments: {
    presets: {
      compact: ['filename', 'title', 'mime', 'size', 'attachable_type', 'attachable_id'],
      standard: [
        'filename',
        'title',
        'mime',
        'size',
        'attachable_type',
        'attachable_id',
        'notes',
        'hash',
        'download_url',
      ],
      full: '*',
    },
  },
};

const VALID_PRESETS: readonly string[] = ['compact', 'standard', 'full'];

/**
 * Resolves a selector to a concrete field list.
 *
 * An unknown preset throws: a caller asking for `verbose` has a wrong idea of what this parameter
 * accepts, and silently substituting a default would hide that. An unknown *entity* is different —
 * that is this module lagging behind a new tool, not caller error — so it degrades to `'*'` with a
 * debug note rather than breaking a working tool.
 */
export function resolveFields(entity: string, selector: FieldSelector): string[] | '*' {
  if (Array.isArray(selector)) return selector;
  if (!VALID_PRESETS.includes(selector)) throw new UnknownFieldPresetError(selector);

  const projection = FIELD_PRESETS[entity];
  if (!projection) {
    debugLog(`[Projection] No presets defined for entity "${entity}"; returning all fields.`);
    return '*';
  }
  return projection.presets[selector];
}

/**
 * Projects one unwrapped item, descending into nested splits where the entity has them.
 *
 * A single-split transaction group is flattened to `{ ...split, id: groupId }`. Two reasons: the
 * `transactions: [ … ]` wrapper costs roughly 60 characters per row once pretty-printed — about 15% of
 * a compact row, which over hundreds of rows is the difference between fitting and not — and it makes
 * a model reason about an indirection on every row for no information gained. The id kept is the
 * group's, which is exactly what `get_transaction`, `update_transaction` and `delete_transaction`
 * take, so the flattened object stays actionable.
 *
 * Multi-split groups keep their array: flattening them would lose data. The two shapes are
 * self-distinguishing — the presence of a `transactions` array — and both are documented on the tools
 * that can return them.
 */
export function projectItem(
  entity: string,
  item: Record<string, unknown>,
  selector: FieldSelector,
): Record<string, unknown> {
  const fields = resolveFields(entity, selector);
  if (fields === '*') return item;

  const projection = FIELD_PRESETS[entity];
  const splitKey = projection?.splitKey;
  if (!splitKey) return pickFields(item, fields);

  const splits = item[splitKey];
  if (!Array.isArray(splits)) {
    // Defensive: an upstream shape change should degrade to a flat projection, not to near-nothing.
    debugLog(`[Projection] Expected "${splitKey}" to be an array on ${entity} ${String(item.id)}.`);
    return pickFields(item, fields);
  }

  const projectedSplits = pickFieldsList(splits as Array<Record<string, unknown>>, fields);
  const root: Record<string, unknown> = { id: item.id };
  for (const key of projection.rootKeep ?? []) {
    // Firefly returns '' rather than null for an unsplit group's title; either way it says nothing.
    if (item[key] !== null && item[key] !== undefined && item[key] !== '') root[key] = item[key];
  }

  if (projectedSplits.length === 1) {
    return { ...projectedSplits[0], ...root };
  }
  return { ...root, [splitKey]: projectedSplits };
}

/** {@link projectItem} over an unwrapped list, preserving pagination. */
export function projectUnwrappedList(entity: string, list: UnwrappedList, selector: FieldSelector): UnwrappedList {
  const fields = resolveFields(entity, selector);
  if (fields === '*') return list;
  return {
    ...list,
    data: list.data.map((item) => projectItem(entity, item, selector)) as UnwrappedList['data'],
  };
}
