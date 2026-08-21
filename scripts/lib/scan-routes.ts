/**
 * Finds every Firefly III route the tool code reaches.
 *
 * Implemented as a small hand-written scanner rather than on the TypeScript AST: this repository is on
 * TypeScript 7, whose native compiler no longer ships a JavaScript compiler API, and pulling in a
 * second TypeScript just to read one argument per call site would be out of proportion. The shape we
 * match is narrow and enforced by convention — `client.<method>(<route>, ...)` — so a scanner that
 * balances quotes and brackets is adequate.
 *
 * Two passes, because neither alone is sufficient:
 *
 *  1. Call sites — reads the route out of the first argument of every `client.<method>(...)` call.
 *     Template literals are normalised: `/accounts/${id}` becomes `/accounts/{p}`.
 *
 *  2. Tables — a few helpers take their route as a parameter (`fetchChart(client, endpoint)`), so pass
 *     1 sees an identifier, not a literal. Rather than guess, the coverage script imports the exported
 *     tables those helpers are driven by and expands them itself.
 *
 * The property that makes this trustworthy is what happens to a call pass 1 cannot resolve and pass 2
 * does not claim: it is reported as an error, never skipped. A route scanner whose default failure
 * mode is a silent false negative is worse than no scanner — it produces a green report over
 * unchecked code.
 */

import { readFileSync } from 'node:fs';

/** Client methods that reach the API, mapped to the HTTP verb they issue. */
export const CLIENT_METHODS: Record<string, string> = {
  get: 'get',
  post: 'post',
  put: 'put',
  delete: 'delete',
  getText: 'get',
  getBinary: 'get',
  postBinary: 'post',
};

/**
 * Functions that legitimately take a route as a parameter. Their routes come from exported tables the
 * coverage script expands; listing a name here asserts that such a table exists and is expanded.
 */
export const TABLE_DRIVEN_HELPERS = new Set([
  'fetchChart',
  'fetchInsightNoX',
  'fetchInsightGrouped',
  'exportEntity',
  'collectSplits',
]);

export interface ScannedRoute {
  method: string;
  /** Normalised route relative to `/api/v1` — e.g. `/accounts/{p}`. */
  route: string;
  file: string;
  line: number;
}

export interface UnresolvedCall {
  file: string;
  line: number;
  text: string;
}

export interface ScanResult {
  routes: ScannedRoute[];
  unresolved: UnresolvedCall[];
}

/**
 * Returns the source span of the first argument of a call whose `(` is at `open`, or null when the
 * call is unterminated. Tracks nesting and string state so a `,` inside a nested call, a template
 * substitution or a string does not end the argument early.
 */
function firstArgument(src: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i).trim();
    } else if (ch === ',' && depth === 1) {
      return src.slice(open + 1, i).trim();
    }
  }
  return null;
}

/** Reads a route out of an argument's source text, or null when it is not a literal. */
export function routeFromArgumentText(text: string): string | null {
  const t = text.trim();
  const quoted = /^'([^'\\]*)'$/.exec(t) ?? /^"([^"\\]*)"$/.exec(t);
  if (quoted) return quoted[1];
  if (t.startsWith('`') && t.endsWith('`') && t.length >= 2) {
    // Every `${...}` collapses to {p}: what it interpolates is irrelevant, only that it is one segment.
    return t.slice(1, -1).replace(/\$\{[^}]*\}/g, '{p}');
  }
  return null;
}

/** Index of the `(` opening a parameter list at or after `from`. */
function paramListStart(src: string, from: number): number {
  return src.indexOf('(', from);
}

/**
 * Index just past the body of the function whose declaration starts at `declStart`, or -1.
 *
 * The body brace is located after the parameter list closes, not by taking the first `{` — a
 * signature like `options: { maxPages?: number } = {}` puts a brace inside the parameters, and
 * matching from there measures the wrong span entirely.
 */
function bodyEnd(src: string, declStart: number): number {
  const paramOpen = paramListStart(src, declStart);
  if (paramOpen === -1) return -1;

  let parenDepth = 0;
  let cursor = paramOpen;
  for (; cursor < src.length; cursor++) {
    if (src[cursor] === '(') parenDepth++;
    else if (src[cursor] === ')') {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }

  const open = src.indexOf('{', cursor);
  if (open === -1) return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Names of the functions whose bodies actually contain `index`.
 *
 * Bounded by brace matching rather than by "the nearest declaration above", which is wrong in two
 * directions: a call after a locally-declared closure gets blamed on that closure, and every call
 * later in a file gets attributed to whichever function was declared last. The second one is worse —
 * it silently suppresses real routes, which is exactly the false-negative this scanner exists to
 * avoid. Callers check whether any *containing* function is declared table-driven.
 */
function enclosingFunctionNames(src: string, index: number): string[] {
  const decl =
    /(?:function\s+([A-Za-z0-9_$]+)\s*\(|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(|function))/g;
  const names: string[] = [];
  for (let m = decl.exec(src); m; m = decl.exec(src)) {
    if (m.index > index) break;
    const end = bodyEnd(src, m.index);
    if (end > index) names.push(m[1] ?? m[2]);
  }
  return names;
}

export function scanSource(filePath: string, src: string): ScanResult {
  const routes: ScannedRoute[] = [];
  const unresolved: UnresolvedCall[] = [];
  const lineAt = (i: number): number => src.slice(0, i).split('\n').length;

  // `client.get<Type>(` — the optional type argument is skipped by the `[^(]*` span.
  const callRe = /\bclient\.([A-Za-z]+)\s*(?:<[^(]*>)?\s*\(/g;
  for (let m = callRe.exec(src); m; m = callRe.exec(src)) {
    const method = CLIENT_METHODS[m[1]];
    if (!method) continue;
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const arg = firstArgument(src, open);
    if (arg === null) continue;

    // Inside a table-driven helper the table is authoritative, whether or not the literal happens to
    // be readable. `exportEntity` interpolates the entity into `/data/export/${entity}`: reading that
    // as one route would both miss the nine real paths and look like a route the spec never defines.
    const enclosing = enclosingFunctionNames(src, m.index);
    if (enclosing.some((fn) => TABLE_DRIVEN_HELPERS.has(fn))) continue;

    const route = routeFromArgumentText(arg);
    if (route !== null) {
      routes.push({ method, route, file: filePath, line: lineAt(m.index) });
    } else {
      unresolved.push({ file: filePath, line: lineAt(m.index), text: `${m[0]}${arg}, …)` });
    }
  }

  return { routes, unresolved };
}

export function scanFiles(filePaths: readonly string[]): ScanResult {
  const routes: ScannedRoute[] = [];
  const unresolved: UnresolvedCall[] = [];
  for (const filePath of filePaths) {
    const result = scanSource(filePath, readFileSync(filePath, 'utf8'));
    routes.push(...result.routes);
    unresolved.push(...result.unresolved);
  }
  return { routes, unresolved };
}
