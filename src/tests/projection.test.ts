import { describe, expect, it } from 'vitest';
import {
  FIELD_PRESETS,
  projectItem,
  projectUnwrappedList,
  resolveFields,
  UnknownFieldPresetError,
} from '../projection.js';
import { type FieldPreset, pickFields, pickFieldsList, unwrapList, unwrapSingle } from '../transform.js';
import {
  makeTransactionList,
  multiSplitTransaction,
  transactionListFixture,
  transactionSingleFixture,
} from './fixtures/transactions.js';

describe('pickFields', () => {
  const obj = { id: '7', name: 'Groceries', amount: '45.00', notes: null, sepa_cc: 'x' };

  it('keeps only the requested fields', () => {
    expect(pickFields(obj, ['name', 'amount'])).toEqual({ id: '7', name: 'Groceries', amount: '45.00' });
  });

  it('always keeps id, even when it is not requested', () => {
    // Without id nothing downstream is possible: no update, no delete, no detail fetch.
    expect(pickFields(obj, ['name'])).toHaveProperty('id', '7');
  });

  it('skips a requested field that is absent, rather than emitting an undefined key', () => {
    const result = pickFields(obj, ['name', 'does_not_exist']);
    // An `undefined` value would still serialise a key and cost tokens for nothing.
    expect(Object.hasOwn(result, 'does_not_exist')).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['id', 'name']);
  });

  it('keeps a field whose value is genuinely null', () => {
    // `category_name: null` is the signal an uncategorised-transaction search looks for, so a real
    // null must survive where an absent key does not.
    expect(pickFields(obj, ['notes'])).toEqual({ id: '7', notes: null });
  });

  it("returns the object unchanged for '*'", () => {
    expect(pickFields(obj, '*')).toEqual(obj);
  });

  it('does not mutate its input', () => {
    const before = { ...obj };
    pickFields(obj, ['name']);
    expect(obj).toEqual(before);
  });

  it('handles an object with no id', () => {
    expect(pickFields({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 });
  });

  it('preserves the order the fields were requested in', () => {
    // Key order is stable in JSON.stringify, so it decides how the model reads each row.
    expect(Object.keys(pickFields(obj, ['amount', 'name']))).toEqual(['id', 'amount', 'name']);
  });
});

describe('pickFieldsList', () => {
  const items = [
    { id: '1', name: 'a', extra: 'x' },
    { id: '2', name: 'b', extra: 'y' },
  ];

  it('projects every item', () => {
    expect(pickFieldsList(items, ['name'])).toEqual([
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ]);
  });

  it("returns items unchanged for '*'", () => {
    expect(pickFieldsList(items, '*')).toEqual(items);
  });

  it('handles an empty list', () => {
    expect(pickFieldsList([], ['name'])).toEqual([]);
  });
});

describe('FIELD_PRESETS', () => {
  it('defines compact, standard and full for every entity it covers', () => {
    for (const [entity, projection] of Object.entries(FIELD_PRESETS)) {
      expect(Object.keys(projection.presets).sort(), entity).toEqual(['compact', 'full', 'standard']);
      expect(projection.presets.full, entity).toBe('*');
    }
  });

  it('makes standard a superset of compact for every entity', () => {
    for (const [entity, projection] of Object.entries(FIELD_PRESETS)) {
      const compact = projection.presets.compact;
      const standard = projection.presets.standard;
      if (compact === '*' || standard === '*') continue;
      for (const field of compact) {
        expect(standard, `${entity}: standard drops '${field}' which compact keeps`).toContain(field);
      }
    }
  });

  it('never puts primary-currency or pc_ fields in compact or standard', () => {
    // Recent additions tied to the administration's primary currency. They duplicate the amount in
    // another currency and are noise for budget analysis.
    for (const [entity, projection] of Object.entries(FIELD_PRESETS)) {
      for (const preset of ['compact', 'standard'] as const) {
        const fields = projection.presets[preset];
        if (fields === '*') continue;
        for (const field of fields) {
          expect(field.startsWith('pc_'), `${entity}.${preset} includes ${field}`).toBe(false);
          expect(field.startsWith('primary_currency'), `${entity}.${preset} includes ${field}`).toBe(false);
        }
      }
    }
  });

  it('keeps the sixteen sepa_ fields out of compact and standard', () => {
    for (const [entity, projection] of Object.entries(FIELD_PRESETS)) {
      for (const preset of ['compact', 'standard'] as const) {
        const fields = projection.presets[preset];
        if (fields === '*') continue;
        expect(
          fields.filter((f) => f.startsWith('sepa_')),
          `${entity}.${preset}`,
        ).toEqual([]);
      }
    }
  });
});

describe('resolveFields', () => {
  it('resolves a preset name to its field list', () => {
    expect(resolveFields('transactions', 'compact')).toContain('amount');
    expect(resolveFields('transactions', 'full')).toBe('*');
  });

  it('passes an explicit field list through', () => {
    expect(resolveFields('transactions', ['amount', 'date'])).toEqual(['amount', 'date']);
  });

  it('throws on an unknown preset, listing the valid ones', () => {
    expect(() => resolveFields('transactions', 'verbose' as FieldPreset)).toThrow(UnknownFieldPresetError);
    expect(() => resolveFields('transactions', 'verbose' as FieldPreset)).toThrow(/compact.*standard.*full/);
  });

  it("falls back to '*' for an entity with no presets defined", () => {
    expect(resolveFields('no_such_entity', 'compact')).toBe('*');
  });
});

describe('projectItem — transaction split nesting', () => {
  it('projects into the splits, not the group root', () => {
    // The group root holds only created_at, updated_at, user, user_group, group_title and the splits
    // array. Projecting root keys would return an object with no money in it at all.
    const item = unwrapSingle(transactionSingleFixture);
    const result = projectItem('transactions', item, 'compact');
    expect(result).toHaveProperty('amount');
    expect(result).toHaveProperty('description');
    expect(result).not.toHaveProperty('user');
  });

  it('flattens a single-split group and keeps the group id', () => {
    const item = unwrapSingle(transactionSingleFixture);
    const result = projectItem('transactions', item, 'compact');
    // The retained id is the group's, which is what get/update/delete_transaction take.
    expect(result.id).toBe('101');
    expect(result).not.toHaveProperty('transactions');
    expect(Object.keys(result).length).toBeLessThanOrEqual(11);
  });

  it('keeps the array for a multi-split group', () => {
    const item = { ...unwrapSingle({ data: multiSplitTransaction } as never) };
    const result = projectItem('transactions', item, 'compact');
    expect(Array.isArray(result.transactions)).toBe(true);
    expect((result.transactions as unknown[]).length).toBe(2);
    expect(result.id).toBe('202');
  });

  it("returns the group untouched for 'full'", () => {
    const item = unwrapSingle(transactionSingleFixture);
    expect(projectItem('transactions', item, 'full')).toEqual(item);
  });

  it('drops the sepa and primary-currency noise from a real split', () => {
    const item = unwrapSingle(transactionSingleFixture);
    const result = projectItem('transactions', item, 'compact');
    for (const key of Object.keys(result)) {
      expect(key.startsWith('sepa_')).toBe(false);
      expect(key.startsWith('pc_')).toBe(false);
    }
  });

  it('falls back to a flat projection when the splits array is missing', () => {
    // Defensive: covers an upstream shape change rather than returning near-nothing silently.
    const result = projectItem('transactions', { id: '9', amount: '1.00', user: '1' }, 'compact');
    expect(result).toEqual({ id: '9', amount: '1.00' });
  });
});

describe('projectItem — flat entities', () => {
  it('projects an account with no nesting involved', () => {
    const account = {
      id: '3',
      name: 'Compte courant',
      type: 'asset',
      current_balance: '2500.00',
      currency_code: 'EUR',
      active: true,
      iban: 'FR7630001007941234567890185',
      notes: null,
      order: 1,
    };
    const result = projectItem('accounts', account, 'compact');
    expect(result).toEqual({
      id: '3',
      name: 'Compte courant',
      type: 'asset',
      current_balance: '2500.00',
      currency_code: 'EUR',
      active: true,
    });
    // iban is standard-only: it is sensitive and rarely needed for analysis.
    expect(result).not.toHaveProperty('iban');
    expect(projectItem('accounts', account, 'standard')).toHaveProperty('iban');
  });
});

describe('projectUnwrappedList', () => {
  it('projects every item and preserves pagination', () => {
    const list = unwrapList(transactionListFixture);
    const result = projectUnwrappedList('transactions', list, 'compact');
    expect(result.pagination).toEqual({ page: 1, totalPages: 21, total: 2008 });
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toHaveProperty('amount');
  });

  it('cuts a real 50-transaction page to well under a quarter of its full size', () => {
    const list = unwrapList(makeTransactionList(50));
    const full = JSON.stringify(projectUnwrappedList('transactions', list, 'full'), null, 2);
    const compact = JSON.stringify(projectUnwrappedList('transactions', list, 'compact'), null, 2);
    expect(compact.length).toBeLessThan(full.length * 0.25);
    // The acceptance criterion: 50 compact transactions fit in 25 000 characters.
    expect(compact.length).toBeLessThan(25_000);
  });
});
