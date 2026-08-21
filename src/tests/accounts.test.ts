import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import { clearCompletionCache } from '../tools/_completions.js';
import {
  clearAccountsCache,
  createAccount,
  deleteAccount,
  fetchAccount,
  fetchAccounts,
  fetchAccountTransactions,
  registerAccountTools,
  searchAccounts,
  updateAccount,
} from '../tools/accounts.js';
import { createMockServer } from './_helpers.js';

const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as FireflyClient;

const listFixture = {
  data: [
    {
      id: '1',
      type: 'accounts',
      attributes: { name: 'Checking', current_balance: '1000.00', active: true },
      links: { self: 'https://firefly.example.com/api/v1/accounts/1' },
    },
  ],
  meta: { pagination: { current_page: 1, total_pages: 1, total: 1 } },
};

const singleFixture = {
  data: {
    id: '42',
    type: 'accounts',
    attributes: { name: 'Savings', current_balance: '5000.00', active: true },
    links: { self: 'https://firefly.example.com/api/v1/accounts/42' },
  },
};

describe('fetchAccounts', () => {
  it('calls /accounts with type filter when type is not "all"', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchAccounts(mockClient, { type: 'asset', page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/accounts', { type: 'asset', page: 1, limit: 50 });
  });

  it('omits type param when type is "all"', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchAccounts(mockClient, { type: 'all', page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/accounts', { page: 1, limit: 50 });
  });

  it('omits type param when type is undefined', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchAccounts(mockClient, { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/accounts', { page: 1, limit: 50 });
  });

  it('returns flat items with pagination', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    const result = await fetchAccounts(mockClient, { page: 1, limit: 50 });
    expect(result.data[0]).toEqual({ name: 'Checking', current_balance: '1000.00', active: true, id: '1' });
    expect(result.pagination).toEqual({ page: 1, totalPages: 1, total: 1 });
  });
});

describe('fetchAccount', () => {
  it('calls /accounts/:id', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(singleFixture);
    await fetchAccount(mockClient, '42');
    expect(mockClient.get).toHaveBeenCalledWith('/accounts/42');
  });

  it('returns flat item', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(singleFixture);
    const result = await fetchAccount(mockClient, '42');
    expect(result).toEqual({ name: 'Savings', current_balance: '5000.00', active: true, id: '42' });
  });
});

const accountSingleFixture = {
  data: {
    id: '10',
    type: 'accounts',
    attributes: { name: 'New Account', type: 'asset', active: true },
    links: {},
  },
};

describe('createAccount', () => {
  it('posts to /accounts with params', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(accountSingleFixture);
    await createAccount(mockClient, { name: 'New Account', type: 'asset', currency_code: 'EUR' });
    expect(mockClient.post).toHaveBeenCalledWith('/accounts', {
      name: 'New Account',
      type: 'asset',
      currency_code: 'EUR',
    });
  });
  it('returns unwrapped single', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(accountSingleFixture);
    const result = await createAccount(mockClient, { name: 'New Account', type: 'asset' });
    expect(result).toEqual({ name: 'New Account', type: 'asset', active: true, id: '10' });
  });
});

describe('updateAccount', () => {
  it('puts to /accounts/:id', async () => {
    mockClient.put = vi.fn().mockResolvedValueOnce(accountSingleFixture);
    await updateAccount(mockClient, '10', { name: 'Renamed' });
    expect(mockClient.put).toHaveBeenCalledWith('/accounts/10', { name: 'Renamed' });
  });
  it('returns unwrapped single', async () => {
    mockClient.put = vi.fn().mockResolvedValueOnce(accountSingleFixture);
    const result = await updateAccount(mockClient, '10', { name: 'Renamed' });
    expect(result).toEqual({ name: 'New Account', type: 'asset', active: true, id: '10' });
  });
});

describe('deleteAccount', () => {
  it('calls delete on /accounts/:id', async () => {
    mockClient.delete = vi.fn().mockResolvedValueOnce(undefined);
    await deleteAccount(mockClient, '10');
    expect(mockClient.delete).toHaveBeenCalledWith('/accounts/10');
  });
  it('returns deleted confirmation', async () => {
    mockClient.delete = vi.fn().mockResolvedValueOnce(undefined);
    const result = await deleteAccount(mockClient, '10');
    expect(result).toEqual({ deleted: true, id: '10' });
  });
});

describe('fetchAccountTransactions', () => {
  it('calls /accounts/:id/transactions with params', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchAccountTransactions(mockClient, '1', { start: '2026-01-01', end: '2026-01-31', page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/accounts/1/transactions', {
      start: '2026-01-01',
      end: '2026-01-31',
      page: 1,
      limit: 50,
    });
  });
  it('omits undefined optional params', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchAccountTransactions(mockClient, '1', { page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/accounts/1/transactions', { page: 1, limit: 50 });
  });
  it('returns unwrapped list', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    const result = await fetchAccountTransactions(mockClient, '1', { page: 1, limit: 50 });
    expect(result.data[0]).toHaveProperty('id');
    expect(result.pagination).toBeDefined();
  });
});

describe('searchAccounts', () => {
  it('calls /search/accounts with query', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await searchAccounts(mockClient, { query: 'Checking', page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/search/accounts', { query: 'Checking', page: 1, limit: 50 });
  });
  it('includes field when provided', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await searchAccounts(mockClient, { query: 'NL01ABNA', field: 'iban', page: 1, limit: 50 });
    expect(mockClient.get).toHaveBeenCalledWith('/search/accounts', {
      query: 'NL01ABNA',
      field: 'iban',
      page: 1,
      limit: 50,
    });
  });
});

describe('handler smoke — accounts', () => {
  it('get_accounts handler returns text content on success', async () => {
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockResolvedValueOnce(listFixture) } as unknown as FireflyClient;
    registerAccountTools(server, client);
    const result = await handlers.get('get_accounts')!({});
    expect(result).toMatchObject({ content: [{ type: 'text', text: expect.any(String) }] });
  });

  it('get_accounts handler returns isError on failure', async () => {
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockRejectedValueOnce(new Error('Network error')) } as unknown as FireflyClient;
    registerAccountTools(server, client);
    const result = await handlers.get('get_accounts')!({});
    expect(result).toMatchObject({ isError: true });
  });
});

describe('account-transactions prompt', () => {
  it('registers the prompt and resolves account arguments', async () => {
    const { server, prompts } = createMockServer();
    const client = {} as FireflyClient;
    registerAccountTools(server, client);

    const promptHandler = prompts.get('account-transactions');
    expect(promptHandler).toBeDefined();

    const result = await promptHandler!({ account: '1 (Checking - asset)' });
    expect(result).toEqual({
      description: 'Get transactions for account ID 1',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Show me the recent transactions for account ID "1".',
          },
        },
      ],
    });
  });
});

describe('accounts autocomplete completions', () => {
  const multiFixture = {
    data: [
      {
        id: '1',
        type: 'accounts',
        attributes: { name: 'Checking', type: 'asset', active: true },
        links: {},
      },
      {
        id: '2',
        type: 'accounts',
        attributes: { name: 'Dieter', type: 'expense', active: true },
        links: {},
      },
      {
        id: '3',
        type: 'accounts',
        attributes: { name: 'Salary', type: 'revenue', active: true },
        links: {},
      },
    ],
    meta: { pagination: { current_page: 1, total_pages: 1, total: 3 } },
  };

  // Returns the registered completion handler for the account-transactions prompt argument.
  function getAccountComplete(client: FireflyClient): (value: string) => Promise<string[]> {
    const { server, promptConfigs } = createMockServer();
    registerAccountTools(server, client);
    const prompt = promptConfigs.get('account-transactions');
    expect(prompt).toBeDefined();
    const accountField = (prompt as any).argsSchema?.account;
    expect(accountField).toBeDefined();
    const meta = (accountField as any)[Symbol.for('mcp.completable')];
    expect(meta).toBeDefined();
    expect(typeof meta.complete).toBe('function');
    return meta.complete;
  }

  beforeEach(() => {
    clearAccountsCache();
    clearCompletionCache();
  });

  it('queries the autocomplete endpoint rather than filtering a full listing in memory', async () => {
    // Previously this fetched up to 1 000 accounts on every keystroke and filtered them locally,
    // which is a large response for a handful of labels and truncates past a thousand accounts.
    const client = { get: vi.fn(), cacheKey: () => 'test-key' } as unknown as FireflyClient;
    const complete = getAccountComplete(client);

    vi.mocked(client.get).mockResolvedValueOnce([
      { id: '2', name: 'Dieter', name_with_balance: 'Dieter', type: 'expense' },
    ]);

    const results = await complete('Dieter');
    expect(client.get).toHaveBeenCalledWith('/autocomplete/accounts', { query: 'Dieter', limit: 100 });
    expect(results).toEqual(['2 (Dieter)']);
  });

  it('falls back to the listing when the autocomplete endpoint is absent', async () => {
    // Firefly versions predating /autocomplete/* must keep working rather than silently losing
    // completions after an upgrade boundary.
    const client = { get: vi.fn(), cacheKey: () => 'fallback-key' } as unknown as FireflyClient;
    const complete = getAccountComplete(client);

    vi.mocked(client.get).mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce(multiFixture);

    const results = await complete('Dieter');
    expect(results).toEqual(['2 (Dieter - expense)']);
  });

  it('scopes the cache per identity so a different token never reuses cached data', async () => {
    const clientA = { get: vi.fn(), cacheKey: () => 'token-a' } as unknown as FireflyClient;
    const clientB = { get: vi.fn(), cacheKey: () => 'token-b' } as unknown as FireflyClient;
    const completeA = getAccountComplete(clientA);
    const completeB = getAccountComplete(clientB);

    vi.mocked(clientA.get).mockResolvedValueOnce([{ id: '2', name_with_balance: 'Dieter' }]);
    vi.mocked(clientB.get).mockResolvedValueOnce([{ id: '9', name_with_balance: 'Bob' }]);

    expect(await completeA('Dieter')).toEqual(['2 (Dieter)']);
    // Different identity must trigger its own fetch, not reuse user A's cached results.
    expect(await completeB('Bob')).toEqual(['9 (Bob)']);
    expect(clientA.get).toHaveBeenCalledTimes(1);
    expect(clientB.get).toHaveBeenCalledTimes(1);
  });

  it('returns nothing when both the endpoint and the fallback fail, rather than throwing', async () => {
    // A completion handler must never throw: a failed suggestion should degrade to no suggestions,
    // not break the tool call carrying it.
    const client = { get: vi.fn(), cacheKey: () => 'failing-key' } as unknown as FireflyClient;
    const complete = getAccountComplete(client);

    vi.mocked(client.get).mockRejectedValue(new Error('Connection error'));
    expect(await complete('')).toEqual([]);
  });

  it('keeps a hit the endpoint matched on a field the label does not show', async () => {
    // Firefly matches accounts on IBAN and account number too. Re-filtering the endpoint's results
    // against the visible label would throw away exactly those hits — searching by IBAN would
    // silently return nothing.
    const client = { get: vi.fn(), cacheKey: () => 'iban-key' } as unknown as FireflyClient;
    const complete = getAccountComplete(client);

    vi.mocked(client.get).mockResolvedValueOnce([{ id: '4', name_with_balance: 'Compte courant' }]);

    expect(await complete('FR7630001007941234567890185')).toEqual(['4 (Compte courant)']);
  });

  it('still filters locally when falling back to the listing', async () => {
    // The fallback fetches everything, so the local filter is the only one there is.
    const client = { get: vi.fn(), cacheKey: () => 'filter-key' } as unknown as FireflyClient;
    const complete = getAccountComplete(client);

    vi.mocked(client.get).mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce(multiFixture);

    expect(await complete('Dieter')).toEqual(['2 (Dieter - expense)']);
  });

  it('does not cache a failure, so the next keystroke retries', async () => {
    // A rejected promise left in the cache would keep replaying the failure for the whole TTL, so a
    // transient blip would look like an autocomplete that stopped working for a minute.
    const client = { get: vi.fn(), cacheKey: () => 'retry-key' } as unknown as FireflyClient;
    const complete = getAccountComplete(client);

    // Both the endpoint and the listing fallback fail on the first attempt.
    vi.mocked(client.get).mockRejectedValue(new Error('boom'));
    expect(await complete('x')).toEqual([]);
    const callsAfterFailure = vi.mocked(client.get).mock.calls.length;

    vi.mocked(client.get).mockReset();
    vi.mocked(client.get).mockResolvedValue([{ id: '2', name_with_balance: 'Dieter' }]);
    expect(await complete('x')).toEqual(['2 (Dieter)']);
    expect(callsAfterFailure).toBeGreaterThan(0);
  });
});
