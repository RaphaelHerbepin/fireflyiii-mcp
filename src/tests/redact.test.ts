import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redact, redactString } from '../redact.js';

describe('redactString', () => {
  it('masks an IBAN wherever it appears in free text', () => {
    expect(redactString('account FR7630001007941234567890185 rejected')).not.toContain('FR7630001007941234567890185');
    expect(redactString('account FR7630001007941234567890185 rejected')).toContain('[redacted]');
  });

  it('masks a spaced IBAN', () => {
    expect(redactString('FR76 3000 1007 9412 3456 7890 185')).toContain('[redacted]');
  });

  it('masks a JWT, which is what a Firefly personal access token is', () => {
    const jwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIn0.abc-def_123';
    expect(redactString(`Bearer ${jwt}`)).not.toContain('eyJhdWQ');
  });

  it('masks a bearer credential even when it is not a JWT', () => {
    expect(redactString('Authorization: Bearer abc123secret')).not.toContain('abc123secret');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Fetched 42 transactions for budget 7 totalling 1234.56 EUR';
    expect(redactString(text)).toBe(text);
  });

  it('does not mask long digit runs, which would eat ids and amounts', () => {
    // A regex broad enough to catch account numbers by shape also eats transaction ids and totals,
    // making debug output useless. Account numbers are handled by key name instead.
    expect(redactString('transaction 1234567890 for 9876543.21')).toBe('transaction 1234567890 for 9876543.21');
  });
});

describe('redact', () => {
  it('masks values under sensitive keys regardless of their shape', () => {
    const result = redact({
      iban: 'FR7630001007941234567890185',
      account_number: '00012345678',
      name: 'Compte',
    }) as Record<string, unknown>;
    expect(result.iban).toBe('[redacted]');
    expect(result.account_number).toBe('[redacted]');
    expect(result.name).toBe('Compte');
  });

  it('matches sensitive keys case-insensitively', () => {
    const result = redact({ IBAN: 'x', Authorization: 'y' }) as Record<string, unknown>;
    expect(result.IBAN).toBe('[redacted]');
    expect(result.Authorization).toBe('[redacted]');
  });

  it('descends into nested objects and arrays', () => {
    const result = redact({ data: [{ attributes: { iban: 'FR76…', amount: '10.00' } }] }) as {
      data: Array<{ attributes: Record<string, unknown> }>;
    };
    expect(result.data[0].attributes.iban).toBe('[redacted]');
    expect(result.data[0].attributes.amount).toBe('10.00');
  });

  it('stops descending past a sane depth rather than walking a huge payload', () => {
    let deep: unknown = { iban: 'secret' };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    // Debug logging must never become the dominant cost of a request.
    expect(() => redact(deep)).not.toThrow();
  });

  it('survives a circular structure', () => {
    const node: Record<string, unknown> = { name: 'x' };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
  });

  it('passes primitives through untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });
});

describe('debugLog', () => {
  const ORIGINAL = process.env.FIREFLY_DEBUG;

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FIREFLY_DEBUG;
    else process.env.FIREFLY_DEBUG = ORIGINAL;
    vi.restoreAllMocks();
  });

  it('never writes an IBAN to stderr, even in debug mode', async () => {
    // DEBUG_ENABLED is captured at import time, so the module must be re-imported after setting the
    // variable. Without resetModules this test passes green while never executing the debug branch.
    process.env.FIREFLY_DEBUG = 'true';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { debugLog } = await import('../debug.js');

    debugLog('[Autocomplete] account', { iban: 'FR7630001007941234567890185', name: 'Compte courant' });

    expect(spy).toHaveBeenCalled();
    const written = JSON.stringify(spy.mock.calls);
    expect(written).not.toContain('FR7630001007941234567890185');
    expect(written).toContain('Compte courant');
  });

  it('writes nothing at all when debug is off', async () => {
    delete process.env.FIREFLY_DEBUG;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { debugLog } = await import('../debug.js');
    debugLog('anything');
    expect(spy).not.toHaveBeenCalled();
  });
});
