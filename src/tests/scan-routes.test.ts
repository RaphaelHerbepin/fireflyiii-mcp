// These tests pass template-literal source in as data, so a plain string containing `${...}` is the
// subject under test, not a mistake.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: asserting on template-literal source text

import { describe, expect, it } from 'vitest';
import { routeFromArgumentText, scanSource } from '../../scripts/lib/scan-routes.js';

describe('routeFromArgumentText', () => {
  it('reads plain string literals', () => {
    expect(routeFromArgumentText("'/accounts'")).toBe('/accounts');
    expect(routeFromArgumentText('"/accounts"')).toBe('/accounts');
  });

  it('collapses template substitutions to {p}', () => {
    expect(routeFromArgumentText('`/accounts/${id}`')).toBe('/accounts/{p}');
    expect(routeFromArgumentText('`/currencies/${encodeURIComponent(code)}/enable`')).toBe('/currencies/{p}/enable');
    expect(routeFromArgumentText('`/piggy-banks/${id}/events/${eventId}`')).toBe('/piggy-banks/{p}/events/{p}');
  });

  it('returns null for a bare identifier', () => {
    expect(routeFromArgumentText('endpoint')).toBeNull();
    expect(routeFromArgumentText('`/data/export/` + entity')).toBeNull();
  });
});

describe('scanSource', () => {
  it('finds routes and maps client methods to verbs', () => {
    const src = `
      await client.get<JsonApiListResponse>('/accounts', query);
      await client.post('/accounts', body);
      await client.put(\`/accounts/\${id}\`, body);
      await client.delete(\`/accounts/\${id}\`);
      await client.getText('/data/export/transactions', query);
    `;
    const { routes, unresolved } = scanSource('t.ts', src);
    expect(unresolved).toEqual([]);
    expect(routes.map((r) => `${r.method} ${r.route}`)).toEqual([
      'get /accounts',
      'post /accounts',
      'put /accounts/{p}',
      'delete /accounts/{p}',
      'get /data/export/transactions',
    ]);
  });

  it('is not confused by a comma inside a nested call or a template substitution', () => {
    const src = 'await client.get(`/tags/${encodeURIComponent(tag, true)}/transactions`, { page, limit });';
    const { routes } = scanSource('t.ts', src);
    expect(routes[0].route).toBe('/tags/{p}/transactions');
  });

  it('ignores methods that do not reach the API', () => {
    expect(scanSource('t.ts', "client.cacheKey(); client.buildUrl('/nope');").routes).toEqual([]);
  });

  // The load-bearing behaviour: an unresolvable route must surface, never be skipped.
  it('reports an unresolved route when the enclosing function is not declared table-driven', () => {
    const src = `
      export async function fetchSomething(client: FireflyClient, endpoint: string) {
        return client.get(endpoint, { start, end });
      }
    `;
    const { routes, unresolved } = scanSource('t.ts', src);
    expect(routes).toEqual([]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].file).toBe('t.ts');
  });

  it('accepts an unresolved route inside a declared table-driven helper', () => {
    const src = `
      export async function fetchChart(client: FireflyClient, endpoint: string) {
        return client.get(endpoint, { start, end });
      }
    `;
    expect(scanSource('t.ts', src).unresolved).toEqual([]);
  });

  it('leaves routes inside a table-driven helper to its table, even when the literal is readable', () => {
    // exportEntity interpolates into `/data/export/${entity}`. Reading that as one route would both
    // miss the nine concrete export paths and look like a route the spec never defines.
    const src = `
      export async function exportEntity(client: FireflyClient, entity: ExportEntity) {
        return client.getText(\`/data/export/\${entity}\`, query);
      }
    `;
    const { routes, unresolved } = scanSource('t.ts', src);
    expect(routes).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it('reports line numbers', () => {
    const { routes } = scanSource('t.ts', "\n\nclient.get('/about');\n");
    expect(routes[0].line).toBe(3);
  });
});

describe('scanSource — enclosing function detection', () => {
  it('does not attribute a call to a closure declared earlier in the same function', () => {
    // collectSplits declares an `absorb` helper before its second client.get. Blaming `absorb` would
    // report a route the enclosing function had already declared as table-driven.
    const src = `
      export async function collectSplits(client: FireflyClient, path: Route) {
        const first = await client.get(path, { page: 1 });
        const absorb = (r: unknown): void => { rows.push(r); };
        absorb(await client.get(path, { page: 2 }));
      }
    `;
    expect(scanSource('t.ts', src).unresolved).toEqual([]);
  });

  it('finds the body brace past a parameter list containing an inline object type', () => {
    // `options: { maxPages?: number } = {}` puts a brace inside the signature. Matching from the
    // first `{` measures the wrong span and loses the function entirely.
    const src = `
      export async function collectSplits(client: C, path: Route, options: { maxPages?: number } = {}) {
        return client.get(path, {});
      }
    `;
    expect(scanSource('t.ts', src).unresolved).toEqual([]);
  });

  it('still reports a dynamic route in a function that is not table-driven', () => {
    // The regression guard for the fix above: broadening enclosure must not suppress real findings.
    const src = `
      export async function collectSplits(client: C, path: Route) {
        return client.get(path, {});
      }
      export async function somethingElse(client: C, endpoint: string) {
        return client.get(endpoint, {});
      }
    `;
    const { unresolved } = scanSource('t.ts', src);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].line).toBe(6);
  });

  it('does not suppress literal routes declared after a table-driven function', () => {
    // Attributing every later call to the last declaration seen would silently drop these, which is
    // the false negative this scanner exists to prevent.
    const src = `
      export async function exportEntity(client: C, entity: string) {
        return client.getText(\`/data/export/\${entity}\`, {});
      }
      export async function fetchAbout(client: C) {
        return client.get('/about');
      }
      export async function fetchTags(client: C) {
        return client.get('/tags');
      }
    `;
    const { routes, unresolved } = scanSource('t.ts', src);
    expect(unresolved).toEqual([]);
    expect(routes.map((r) => r.route)).toEqual(['/about', '/tags']);
  });
});
