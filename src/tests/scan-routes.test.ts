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
