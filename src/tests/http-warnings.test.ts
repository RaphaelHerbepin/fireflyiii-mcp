import { afterEach, describe, expect, it, vi } from 'vitest';
import { warnAboutHttpExposure } from '../http.js';

describe('warnAboutHttpExposure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const capture = (options: Parameters<typeof warnAboutHttpExposure>[0], host: string): string => {
    // Restored per call: spying twice on the same method reuses one mock, so a second capture in the
    // same test would still see the first one's output.
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnAboutHttpExposure(options, host);
    const written = spy.mock.calls.map((c) => String(c[0])).join('\n');
    spy.mockRestore();
    return written;
  };

  it('says plainly that writes are enabled when they are', () => {
    expect(capture({}, '127.0.0.1')).toMatch(/write tools are ENABLED/);
  });

  it('says nothing about writes in read-only mode', () => {
    expect(capture({ readOnly: true }, '127.0.0.1')).not.toMatch(/write tools are ENABLED/);
  });

  it('warns about the absence of authentication only off loopback', () => {
    // On loopback this would be noise on every local run, and noise is what makes warnings ignored.
    expect(capture({ readOnly: true }, '0.0.0.0')).toMatch(/no authentication of its own/);
    expect(capture({ readOnly: true }, '127.0.0.1')).not.toMatch(/no authentication of its own/);
  });

  it('warns when the irreversible tools are enabled', () => {
    expect(capture({ readOnly: true, groups: ['admin-destructive'] }, '127.0.0.1')).toMatch(/irreversibly/);
  });

  it('stays silent when a read-only server is bound to loopback', () => {
    expect(capture({ readOnly: true, groups: ['accounts'] }, '127.0.0.1')).toBe('');
  });
});
