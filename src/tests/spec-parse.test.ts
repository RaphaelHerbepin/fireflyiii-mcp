import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_OPERATIONS,
  EXPECTED_PATHS,
  parseSpecOperations,
  parseSpecOperationsChecked,
  SpecParseError,
  toClientRoute,
} from '../../scripts/lib/parse-spec.js';

// A miniature spec exercising every shape the real one contains, plus the traps: a `parameters:`
// block whose entries sit at the same depth as method keys, a nested `schema:` with a `get`-like
// key, and a `components:` section that must terminate scanning.
const FIXTURE = `openapi: 3.0.0
info:
  title: Test
paths:
  /v1/accounts:
    get:
      tags:
        - accounts
      operationId: listAccount
      parameters:
        - in: query
          name: limit
    post:
      operationId: storeAccount
  /v1/accounts/{id}:
    get:
      operationId: getAccount
      responses:
        "200":
          description: ok
    delete:
      operationId: deleteAccount
components:
  schemas:
    Account:
      type: object
      properties:
        get:
          type: string
`;

describe('parseSpecOperations', () => {
  it('extracts every method/path/operationId triple', () => {
    expect(parseSpecOperations(FIXTURE)).toEqual([
      { method: 'get', path: '/v1/accounts', operationId: 'listAccount' },
      { method: 'post', path: '/v1/accounts', operationId: 'storeAccount' },
      { method: 'get', path: '/v1/accounts/{id}', operationId: 'getAccount' },
      { method: 'delete', path: '/v1/accounts/{id}', operationId: 'deleteAccount' },
    ]);
  });

  it('stops at the next top-level key so components/ is never scanned', () => {
    // `Account.properties.get` would otherwise be read as a method.
    expect(parseSpecOperations(FIXTURE).map((o) => o.operationId)).not.toContain(undefined);
    expect(parseSpecOperations(FIXTURE)).toHaveLength(4);
  });

  it('ignores parameter entries indented like method keys', () => {
    const ops = parseSpecOperations(FIXTURE).filter((o) => o.path === '/v1/accounts');
    expect(ops.map((o) => o.method)).toEqual(['get', 'post']);
  });

  it('returns nothing when there is no paths section', () => {
    expect(parseSpecOperations('openapi: 3.0.0\ncomponents:\n  schemas: {}\n')).toEqual([]);
  });
});

describe('parseSpecOperationsChecked', () => {
  it('rejects a spec whose fingerprint does not match', () => {
    // The guard exists so a reformatted upstream spec fails loudly instead of reporting full coverage.
    expect(() => parseSpecOperationsChecked(FIXTURE)).toThrow(SpecParseError);
    expect(() => parseSpecOperationsChecked(FIXTURE)).toThrow(/fingerprint mismatch/);
  });
});

describe('toClientRoute', () => {
  it('strips the /v1 prefix and normalises path parameters', () => {
    expect(toClientRoute('/v1/accounts/{id}')).toBe('/accounts/{p}');
    expect(toClientRoute('/v1/exchange-rates/{from}/{to}/{date}')).toBe('/exchange-rates/{p}/{p}/{p}');
    expect(toClientRoute('/v1/accounts')).toBe('/accounts');
  });
});

describe('the vendored spec itself', () => {
  const yaml = readFileSync(new URL('../../spec/firefly-iii-6.5.5-v1.yaml', import.meta.url), 'utf8');

  it(`parses to exactly ${EXPECTED_OPERATIONS} operations across ${EXPECTED_PATHS} paths`, () => {
    const operations = parseSpecOperationsChecked(yaml);
    expect(operations).toHaveLength(EXPECTED_OPERATIONS);
    expect(new Set(operations.map((o) => o.path)).size).toBe(EXPECTED_PATHS);
  });

  it('contains the operations the plan depends on', () => {
    const byId = new Map(parseSpecOperationsChecked(yaml).map((o) => [o.operationId, o]));
    // Sanity anchors: one per phase of the coverage work.
    expect(byId.get('getBudgetLimit')).toEqual({
      method: 'get',
      path: '/v1/budgets/{id}/limits/{limitId}',
      operationId: 'getBudgetLimit',
    });
    expect(byId.get('listWebhook')?.path).toBe('/v1/webhooks');
    expect(byId.get('getPrimaryCurrency')?.path).toBe('/v1/currencies/primary');
    expect(byId.get('destroyData')?.method).toBe('delete');
  });

  it('does not define the routes the code currently calls but the spec omits', () => {
    // Pins the phantom-route finding so a spec bump that adds them is noticed.
    const routes = new Set(parseSpecOperationsChecked(yaml).map((o) => `${o.method} ${o.path}`));
    expect(routes.has('put /v1/budget-limits/{id}')).toBe(false);
    expect(routes.has('get /v1/exchange-rates/by-currencies/{from}/{to}')).toBe(false);
    expect(routes.has('get /v1/summary/net-worth')).toBe(false);
    expect(routes.has('post /v1/object-groups')).toBe(false);
  });
});
