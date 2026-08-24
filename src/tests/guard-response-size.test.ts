import { describe, expect, it } from 'vitest';
import { guardResponseSize, MAX_RESPONSE_CHARS } from '../tools/_helpers.js';
import type { UnwrappedList } from '../transform.js';

/** A list of `count` items, each padded to roughly `size` characters. */
function listOf(count: number, size = 100): UnwrappedList {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      id: String(i),
      description: 'x'.repeat(Math.max(0, size - 40)),
    })),
    pagination: { page: 1, totalPages: 21, total: 2008 },
  };
}

describe('guardResponseSize', () => {
  it('leaves a small list completely alone', () => {
    const list = listOf(10);
    const result = guardResponseSize(list);
    expect(result.data).toHaveLength(10);
    // No `truncated` key at all, rather than one set to undefined: a key costs tokens and invites
    // the reader to wonder what it means.
    expect(Object.hasOwn(result, 'truncated')).toBe(false);
  });

  it('truncates an oversized list and keeps the result under the limit', () => {
    const result = guardResponseSize(listOf(4000, 200));
    expect(result.data.length).toBeLessThan(4000);
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });

  it('reports exactly how many items were omitted', () => {
    const list = listOf(4000, 200);
    const result = guardResponseSize(list);
    expect(result.truncated).toBeDefined();
    expect(result.truncated?.returned).toBe(result.data.length);
    expect(result.truncated?.omitted).toBe(4000 - result.data.length);
    expect(result.truncated?.returned + result.truncated!.omitted).toBe(4000);
  });

  it('names the reason and a concrete way out', () => {
    const result = guardResponseSize(listOf(4000, 200));
    expect(result.truncated?.reason).toBe('response_size_limit');
    // A truncation the model cannot act on is only marginally better than a silent one.
    expect(result.truncated?.hint).toMatch(/date range|limit|compact|aggregate/i);
  });

  it('always returns at least one item, even when that item alone busts the budget', () => {
    // Returning an empty data array for a non-empty result would be a lie, and a worse one than an
    // oversized response: the model concludes "there is nothing" instead of "there is too much".
    const huge: UnwrappedList = {
      data: [{ id: '1', blob: 'x'.repeat(MAX_RESPONSE_CHARS * 2) }],
    };
    const result = guardResponseSize(huge);
    expect(result.data).toHaveLength(1);
    expect(result.truncated).toBeUndefined();
  });

  it('flags truncation when a single oversized item is followed by others', () => {
    const result = guardResponseSize({
      data: [
        { id: '1', blob: 'x'.repeat(MAX_RESPONSE_CHARS * 2) },
        { id: '2', blob: 'small' },
      ],
    });
    expect(result.data).toHaveLength(1);
    expect(result.truncated?.omitted).toBe(1);
  });

  it('preserves pagination so the caller can still page through', () => {
    const result = guardResponseSize(listOf(4000, 200));
    expect(result.pagination).toEqual({ page: 1, totalPages: 21, total: 2008 });
  });

  it('handles an empty list', () => {
    const result = guardResponseSize({ data: [] });
    expect(result.data).toEqual([]);
    expect(result.truncated).toBeUndefined();
  });

  it('counts the characters that will actually be emitted, indentation included', () => {
    // defineTool serialises with two-space indent, and nesting under data[] adds four more per line.
    // Measuring the compact form would under-count by roughly a third and overshoot the budget.
    const result = guardResponseSize(listOf(4000, 200));
    const emitted = JSON.stringify(result, null, 2);
    expect(emitted.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(emitted.length).toBeGreaterThan(MAX_RESPONSE_CHARS * 0.5);
  });
});
