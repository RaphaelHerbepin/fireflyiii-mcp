/**
 * Probes the routes this server calls that OpenAPI spec 6.5.5 does not define.
 *
 * `scripts/check-api-coverage.ts` finds them statically; only a live instance can say whether they
 * work anyway — Firefly III does keep undocumented compatibility routes, so "absent from the spec" is
 * a suspicion, not a verdict. This file turns the suspicion into evidence, and then pins the evidence
 * so a later Firefly version that restores one of these routes shows up as a failing test rather than
 * as a tool that quietly starts working again.
 *
 * Verdicts recorded against Firefly III 6.5.5 (API 6.5.5) on 2026-08-21: all seven are gone, and the
 * four tools calling them are dead. See spec/coverage-exceptions.json.
 *
 * Run with FIREFLY_INTEGRATION=true against a disposable instance — several probes write.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { FireflyClient, FireflyError } from '../client.js';

const SKIP = !process.env.FIREFLY_INTEGRATION;

/** Issues the request and returns the HTTP status, treating an error response as data rather than a
 *  failure — the status is the thing under test. */
async function statusOf(call: () => Promise<unknown>): Promise<number> {
  try {
    await call();
    return 200;
  } catch (err) {
    if (err instanceof FireflyError) return err.status;
    throw err;
  }
}

describe.skipIf(SKIP)('Phantom routes: called by this server, absent from spec 6.5.5', () => {
  let client: FireflyClient;

  beforeAll(() => {
    const url = process.env.FIREFLY_URL;
    const token = process.env.FIREFLY_TOKEN;
    if (!url || !token) throw new Error('FIREFLY_URL and FIREFLY_TOKEN must be set');
    client = new FireflyClient(url, token);
  });

  describe('reads', () => {
    it('GET /summary/net-worth is gone — get_net_worth_summary is dead', async () => {
      expect(await statusOf(() => client.get('/summary/net-worth'))).toBe(404);
    });

    it('GET /exchange-rates/by-currencies/{from}/{to} is gone — that path is POST-only', async () => {
      expect(await statusOf(() => client.get('/exchange-rates/by-currencies/EUR/USD'))).toBe(404);
    });

    it('GET /exchange-rates/{from}/{to} is the route the spec defines, and it works', async () => {
      // The replacement get_exchange_rate should call this instead.
      expect(await statusOf(() => client.get('/exchange-rates/EUR/USD'))).toBe(200);
    });
  });

  describe('writes', () => {
    let accountId: string;
    let budgetId: string;
    let limitId: string;
    let piggyBankId: string;

    beforeAll(async () => {
      const account = await client.post<{ data: { id: string } }>('/accounts', {
        name: `Phantom probe ${Date.now()}`,
        type: 'asset',
        account_role: 'defaultAsset',
        currency_code: 'EUR',
      });
      accountId = account.data.id;

      const budget = await client.post<{ data: { id: string } }>('/budgets', {
        name: `Phantom probe ${Date.now()}`,
      });
      budgetId = budget.data.id;

      const limit = await client.post<{ data: { id: string } }>(`/budgets/${budgetId}/limits`, {
        start: '2025-01-01',
        end: '2025-01-31',
        amount: '100.00',
        currency_code: 'EUR',
      });
      limitId = limit.data.id;

      const piggy = await client.post<{ data: { id: string } }>('/piggy-banks', {
        name: `Phantom probe ${Date.now()}`,
        // accounts[] rather than account_id — see the schema test below.
        accounts: [{ account_id: accountId }],
        target_amount: '500.00',
        start_date: '2025-01-01',
        transaction_currency_code: 'EUR',
      });
      piggyBankId = piggy.data.id;
    });

    it('PUT /budget-limits/{id} is gone — update_budget_limit is dead', async () => {
      expect(await statusOf(() => client.put(`/budget-limits/${limitId}`, { amount: '150.00' }))).toBe(404);
    });

    it('PUT /budgets/{id}/limits/{limitId} is the route the spec defines, and it works', async () => {
      expect(await statusOf(() => client.put(`/budgets/${budgetId}/limits/${limitId}`, { amount: '150.00' }))).toBe(
        200,
      );
    });

    it('DELETE /budget-limits/{id} is gone — delete_budget_limit is dead', async () => {
      expect(await statusOf(() => client.delete(`/budget-limits/${limitId}`))).toBe(404);
    });

    it('POST /object-groups is not allowed — create_object_group is dead', async () => {
      // 405, not 404: the collection exists for GET. Object groups are created implicitly, by setting
      // object_group_title on a piggy bank or a bill.
      expect(await statusOf(() => client.post('/object-groups', { title: 'probe', order: 1 }))).toBe(405);
    });

    it('POST /piggy-banks/{id}/events is not allowed — create_piggy_bank_event is dead', async () => {
      expect(await statusOf(() => client.post(`/piggy-banks/${piggyBankId}/events`, { amount: '50.00' }))).toBe(405);
    });

    it('DELETE /piggy-banks/{id}/events/{eventId} is gone — delete_piggy_bank_event is dead', async () => {
      expect(await statusOf(() => client.delete(`/piggy-banks/${piggyBankId}/events/1`))).toBe(404);
    });

    it('GET /piggy-banks/{id}/events does work — reading events is fine', async () => {
      expect(await statusOf(() => client.get(`/piggy-banks/${piggyBankId}/events`))).toBe(200);
    });
  });

  describe('schema drift', () => {
    let accountId: string;

    beforeAll(async () => {
      const account = await client.post<{ data: { id: string } }>('/accounts', {
        name: `Schema probe ${Date.now()}`,
        type: 'asset',
        account_role: 'defaultAsset',
        currency_code: 'EUR',
      });
      accountId = account.data.id;
    });

    it('PiggyBankStore requires accounts[], not account_id — create_piggy_bank is dead as written', async () => {
      // The spec lists account_id under `required` but does not declare it in `properties`, which is
      // an upstream inconsistency. The instance settles it: accounts[] is what is actually required.
      const status = await statusOf(() =>
        client.post('/piggy-banks', {
          name: `Schema probe ${Date.now()}`,
          account_id: accountId,
          target_amount: '500.00',
          start_date: '2025-01-01',
        }),
      );
      expect(status).toBe(422);
    });

    it('accepts the same piggy bank once accounts[] and a currency are supplied', async () => {
      const status = await statusOf(() =>
        client.post('/piggy-banks', {
          name: `Schema probe ok ${Date.now()}`,
          accounts: [{ account_id: accountId }],
          target_amount: '500.00',
          start_date: '2025-01-01',
          transaction_currency_code: 'EUR',
        }),
      );
      expect(status).toBe(200);
    });
  });

  describe('data/destroy', () => {
    it('requires the objects parameter the spec does not document', async () => {
      // The spec declares no parameters at all for this operation; the instance rejects the call
      // without `objects`. Worth pinning before admin-destructive tools are built on it.
      expect(await statusOf(() => client.delete('/data/destroy'))).toBe(422);
    });
  });
});
