import { describe, expect, it, vi } from 'vitest';
import { FireflyClient, FireflyError, FireflyTimeoutError, formatError } from '../client.js';

describe('formatError — 403', () => {
  it('explains that the endpoint needs administrator rights', () => {
    // Previously fell through to "API error 403." with no context. The admin endpoints return this
    // routinely on an ordinary token, and "API error 403" gives a caller nothing to act on.
    const message = formatError(new FireflyError(403, 'https://f.example.com/api/v1/users', ''));
    expect(message).toMatch(/administrator/i);
    expect(message).not.toBe('API error 403.');
  });

  it('still handles the codes it already handled', () => {
    expect(formatError(new FireflyError(401, 'u', ''))).toMatch(/Authentication failed/);
    expect(formatError(new FireflyError(404, 'u', ''))).toMatch(/not found/i);
    expect(formatError(new FireflyError(500, 'u', ''))).toMatch(/server error/i);
  });

  it('explains a 429 rather than emitting a bare code', () => {
    expect(formatError(new FireflyError(429, 'u', ''))).toMatch(/too many requests|rate/i);
  });
});

describe('timeout errors do not leak the query string', () => {
  it('reports the path without its parameters', async () => {
    // The old message interpolated the full URL, so a timeout on search_accounts?query=<IBAN> wrote
    // that IBAN into the error — while FireflyError had been stripping query strings all along.
    const client = new FireflyClient('https://firefly.example.com', 'token');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    await expect(client.get('/search/accounts', { query: 'FR7630001007941234567890185' })).rejects.toThrow(
      FireflyTimeoutError,
    );

    try {
      await client.get('/search/accounts', { query: 'FR7630001007941234567890185' });
    } catch (err) {
      expect((err as Error).message).not.toContain('FR7630001007941234567890185');
      expect((err as Error).message).toContain('/search/accounts');
      expect(formatError(err)).not.toContain('FR7630001007941234567890185');
    }
    vi.restoreAllMocks();
  });

  it('is formatted as a timeout rather than as a raw message', () => {
    expect(formatError(new FireflyTimeoutError('https://f.example.com/api/v1/x?q=secret', 30_000))).toMatch(
      /timed out/i,
    );
    expect(formatError(new FireflyTimeoutError('https://f.example.com/api/v1/x?q=secret', 30_000))).not.toContain(
      'secret',
    );
  });
});
