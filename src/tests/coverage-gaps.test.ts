/**
 * Direct tests for the fetch functions the group suites did not reach.
 *
 * Written after a coverage pass found 26 exported functions never called from a test. Most were added
 * late, in groups whose suites concentrated on the tools that carried the risky logic — but "the
 * interesting parts are tested" is how a path that builds the wrong URL survives to production. Each
 * of these asserts the two things a fetch function can get wrong: the path it builds and the shape it
 * returns.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  createPreference,
  createUser,
  deleteUser,
  fetchPreference,
  fetchPreferences,
  fetchUser,
  fetchUserGroup,
  fetchUserGroups,
  fetchUsers,
  finishBatch,
  updateUser,
  updateUserGroup,
} from '../tools/admin.js';
import { fetchAttachmentsFor } from '../tools/attachments.js';
import { fetchBillRules } from '../tools/bills.js';
import { fetchAllBudgetLimits, fetchBudgetLimitTransactions } from '../tools/budgets.js';
import { fetchPrimaryCurrency } from '../tools/currencies.js';
import { storeRatesByDate, storeRatesByPair } from '../tools/exchange-rates.js';
import { fetchAccountPiggyBanks } from '../tools/piggy-banks.js';
import { fetchAutocomplete, toSuggestions } from '../tools/search.js';
import {
  deleteTransactionJournal,
  fetchTransactionByJournal,
  fetchTransactionPiggyBankEvents,
} from '../tools/transactions.js';
import { deleteWebhookMessageAttempt } from '../tools/webhooks.js';

/** A JSON:API list envelope wrapping one item. */
const list = (attributes: Record<string, unknown> = {}) => ({
  data: [{ id: '1', type: 'thing', attributes, links: {} }],
  meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
});

/** A JSON:API single envelope. */
const single = (attributes: Record<string, unknown> = {}) => ({
  data: { id: '1', type: 'thing', attributes, links: {} },
});

const clientWith = (method: 'get' | 'post' | 'put' | 'delete', value: unknown) => {
  const fn = vi.fn().mockResolvedValue(value);
  return { client: { [method]: fn } as unknown as FireflyClient, fn };
};

describe('admin fetch functions', () => {
  it('reads users and one user', async () => {
    const { client, fn } = clientWith('get', list({ email: 'a@b.test' }));
    expect((await fetchUsers(client, { page: 2, limit: 10 })).data[0]).toMatchObject({ email: 'a@b.test' });
    expect(fn).toHaveBeenCalledWith('/users', { page: 2, limit: 10 });

    const one = clientWith('get', single({ email: 'a@b.test', role: 'owner' }));
    expect(await fetchUser(one.client, '7')).toMatchObject({ id: '1', role: 'owner' });
    expect(one.fn).toHaveBeenCalledWith('/users/7');
  });

  it('creates, updates and deletes a user', async () => {
    const created = clientWith('post', single({ email: 'new@b.test' }));
    await createUser(created.client, { email: 'new@b.test' });
    expect(created.fn).toHaveBeenCalledWith('/users', { email: 'new@b.test' });

    const updated = clientWith('put', single({ blocked: true }));
    await updateUser(updated.client, '7', { blocked: true });
    expect(updated.fn).toHaveBeenCalledWith('/users/7', { blocked: true });

    const removed = clientWith('delete', undefined);
    expect(await deleteUser(removed.client, '7')).toEqual({ deleted: true, id: '7' });
    expect(removed.fn).toHaveBeenCalledWith('/users/7');
  });

  it('encodes an id that is not a plain number', async () => {
    // Ids reach the path directly, and nothing guarantees the caller passes a bare integer.
    const { client, fn } = clientWith('get', single());
    await fetchUser(client, 'a b/c');
    expect(fn).toHaveBeenCalledWith('/users/a%20b%2Fc');
  });

  it('reads user groups', async () => {
    const { client, fn } = clientWith('get', list({ title: 'Main' }));
    await fetchUserGroups(client, { page: 1, limit: 50 });
    expect(fn).toHaveBeenCalledWith('/user-groups', { page: 1, limit: 50 });

    const one = clientWith('get', single({ title: 'Main' }));
    await fetchUserGroup(one.client, '3');
    expect(one.fn).toHaveBeenCalledWith('/user-groups/3');

    const updated = clientWith('put', single({ title: 'Renamed' }));
    await updateUserGroup(updated.client, '3', { title: 'Renamed' });
    expect(updated.fn).toHaveBeenCalledWith('/user-groups/3', { title: 'Renamed' });
  });

  it('reads and writes preferences', async () => {
    const { client, fn } = clientWith('get', list({ name: 'language' }));
    await fetchPreferences(client, { page: 1, limit: 50 });
    expect(fn).toHaveBeenCalledWith('/preferences', { page: 1, limit: 50 });

    const one = clientWith('get', single({ name: 'language', data: 'en_US' }));
    await fetchPreference(one.client, 'language');
    expect(one.fn).toHaveBeenCalledWith('/preferences/language');

    const created = clientWith('post', single({ name: 'x' }));
    await createPreference(created.client, { name: 'x', data: 'y' });
    expect(created.fn).toHaveBeenCalledWith('/preferences', { name: 'x', data: 'y' });
  });

  it('finishes a batch', async () => {
    const { client, fn } = clientWith('post', undefined);
    expect(await finishBatch(client)).toEqual({ finished: true });
    expect(fn).toHaveBeenCalledWith('/batch/finish', {});
  });
});

describe('generic attachment listing', () => {
  it('builds the right path for every attachable type', async () => {
    // Seven endpoints behind one tool: a wrong mapping here silently returns another record's files.
    const expected: Array<[Parameters<typeof fetchAttachmentsFor>[1], string]> = [
      ['account', '/accounts/5/attachments'],
      ['bill', '/bills/5/attachments'],
      ['budget', '/budgets/5/attachments'],
      ['category', '/categories/5/attachments'],
      ['piggy-bank', '/piggy-banks/5/attachments'],
      ['tag', '/tags/5/attachments'],
      ['transaction', '/transactions/5/attachments'],
    ];
    for (const [entity, path] of expected) {
      const { client, fn } = clientWith('get', list());
      await fetchAttachmentsFor(client, entity, '5', {});
      expect(fn, entity).toHaveBeenCalledWith(path, { page: undefined, limit: undefined });
    }
  });

  it('encodes a tag name used as the identifier', async () => {
    // Tags are addressed by name here, and names contain spaces and accents.
    const { client, fn } = clientWith('get', list());
    await fetchAttachmentsFor(client, 'tag', 'vacances été', {});
    expect(fn).toHaveBeenCalledWith('/tags/vacances%20%C3%A9t%C3%A9/attachments', expect.anything());
  });
});

describe('late additions across the other groups', () => {
  it('reads the rules attached to a bill', async () => {
    const { client, fn } = clientWith('get', list({ title: 'Rule' }));
    await fetchBillRules(client, '4');
    expect(fn).toHaveBeenCalledWith('/bills/4/rules');
  });

  it('reads budget limits globally and per limit', async () => {
    const { client, fn } = clientWith('get', list());
    await fetchAllBudgetLimits(client, { start: '2025-01-01', end: '2025-01-31', limit: 10 });
    expect(fn).toHaveBeenCalledWith('/budget-limits', {
      page: undefined,
      limit: 10,
      start: '2025-01-01',
      end: '2025-01-31',
    });

    const txs = clientWith('get', list());
    await fetchBudgetLimitTransactions(txs.client, '3', '9', { page: 1, limit: 50 });
    expect(txs.fn).toHaveBeenCalledWith('/budgets/3/limits/9/transactions', { page: 1, limit: 50 });
  });

  it('reads the primary currency', async () => {
    const { client, fn } = clientWith('get', single({ code: 'EUR' }));
    expect(await fetchPrimaryCurrency(client)).toMatchObject({ code: 'EUR' });
    expect(fn).toHaveBeenCalledWith('/currencies/primary');
  });

  it('reads piggy banks attached to an account', async () => {
    const { client, fn } = clientWith('get', list({ name: 'Vacances' }));
    await fetchAccountPiggyBanks(client, '12');
    expect(fn).toHaveBeenCalledWith('/accounts/12/piggy-banks');
  });

  it('stores rates in bulk, by pair and by date', async () => {
    const byPair = clientWith('post', {});
    await storeRatesByPair(byPair.client, 'EUR', 'USD', { '2025-03-01': '1.08' });
    expect(byPair.fn).toHaveBeenCalledWith('/exchange-rates/by-currencies/EUR/USD', {
      rates: { '2025-03-01': '1.08' },
    });

    const byDate = clientWith('post', {});
    await storeRatesByDate(byDate.client, '2025-03-01', 'EUR', { USD: '1.08' });
    expect(byDate.fn).toHaveBeenCalledWith('/exchange-rates/by-date/2025-03-01', {
      from: 'EUR',
      rates: { USD: '1.08' },
    });
  });

  it('reads and deletes a transaction by journal id', async () => {
    const read = clientWith('get', single({ user: '1', transactions: [] }));
    await fetchTransactionByJournal(read.client, '55');
    expect(read.fn).toHaveBeenCalledWith('/transaction-journals/55');

    const removed = clientWith('delete', undefined);
    expect(await deleteTransactionJournal(removed.client, '55')).toEqual({ deleted: true, id: '55' });
    expect(removed.fn).toHaveBeenCalledWith('/transaction-journals/55');
  });

  it('reads piggy bank events caused by a transaction', async () => {
    const { client, fn } = clientWith('get', list({ amount: '25.00' }));
    await fetchTransactionPiggyBankEvents(client, '88');
    expect(fn).toHaveBeenCalledWith('/transactions/88/piggy-bank-events');
  });

  it('deletes a webhook delivery attempt', async () => {
    const { client, fn } = clientWith('delete', undefined);
    expect(await deleteWebhookMessageAttempt(client, '1', '2', '3')).toEqual({ deleted: true, id: '3' });
    expect(fn).toHaveBeenCalledWith('/webhooks/1/messages/2/attempts/3');
  });
});

describe('autocomplete fetching', () => {
  it('sends query and limit, and omits what the entity does not support', async () => {
    const { client, fn } = clientWith('get', [{ id: '1', name: 'x' }]);
    await fetchAutocomplete(client, 'budgets', { query: 'fix', limit: 25, date: '2025-01-01', types: ['asset'] });
    // date and types are accounts-only; sending them elsewhere would be noise at best.
    expect(fn).toHaveBeenCalledWith('/autocomplete/budgets', { query: 'fix', limit: 25 });
  });

  it('passes date and types through for accounts', async () => {
    const { client, fn } = clientWith('get', []);
    await fetchAutocomplete(client, 'accounts', { query: 'a', date: '2025-01-01', types: ['asset'] });
    expect(fn).toHaveBeenCalledWith('/autocomplete/accounts', {
      query: 'a',
      date: '2025-01-01',
      types: ['asset'],
    });
  });

  it('returns an empty list when the endpoint answers with something unexpected', async () => {
    // These endpoints return a bare array; anything else means a proxy or an error page.
    const { client } = clientWith('get', { unexpected: true });
    expect(await fetchAutocomplete(client, 'tags', {})).toEqual([]);
  });

  it('labels each entity from its own field', async () => {
    expect(toSuggestions('tags', [{ id: '1', tag: 'vacances' }])[0].label).toBe('vacances');
    expect(toSuggestions('object-groups', [{ id: '2', title: 'Projets' }])[0].label).toBe('Projets');
    expect(toSuggestions('accounts', [{ id: '3', name_with_balance: 'Courant (1 200 €)' }])[0].label).toBe(
      'Courant (1 200 €)',
    );
  });

  it('falls back to name when the entity’s label field is absent', async () => {
    expect(toSuggestions('accounts', [{ id: '4', name: 'Sans solde' }])[0].label).toBe('Sans solde');
  });
});
