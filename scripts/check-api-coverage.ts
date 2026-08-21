#!/usr/bin/env tsx
/**
 * Verifies this server's tool code against the vendored Firefly III OpenAPI spec, in both directions:
 *
 *   - every spec operation is either covered by a tool or listed as a written exception;
 *   - every route the code calls exists in the spec, or is listed as a known phantom route.
 *
 * The second direction is the one that earns its keep. Upstream ships four tools calling routes the
 * 6.5.5 spec does not define, and nobody noticed because a one-way check only ever asks "did we miss
 * anything?" — never "are we calling something that isn't there?".
 *
 * Exit codes: 0 clean · 1 coverage or phantom failure · 2 parse/config failure.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COLLECT_SPLITS_ROUTES } from '../src/tools/aggregates.js';
import { CURRENCY_SUBRESOURCES } from '../src/tools/currencies.js';
import { EXPORT_TOOLS } from '../src/tools/exports.js';
import { CHART_ENDPOINTS, INSIGHT_GROUPED_TOOLS, INSIGHT_NO_X_TOOLS } from '../src/tools/reports.js';
import { AUTOCOMPLETE_ENTITIES } from '../src/tools/search.js';
import { parseSpecOperationsChecked, type SpecOperation, toClientRoute } from './lib/parse-spec.js';
import { scanFiles } from './lib/scan-routes.js';

const repoRoot = new URL('..', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, repoRoot), 'utf8');

interface Exception {
  reason?: string;
}
interface UncoveredException extends Exception {
  operationId: string;
}
interface PhantomException extends Exception {
  method: string;
  path: string;
}
interface ExceptionsFile {
  specSha256?: string;
  /** Permanent, justified gaps. Reviewed on their merits, not expected to shrink. */
  uncovered: UncoveredException[];
  /** Routes verified to work against a live instance despite being absent from the spec. */
  phantomRoutes: PhantomException[];
  /**
   * Known debt inherited from upstream, expected to shrink to nothing. Modelled on the repo's existing
   * relative audit (scripts/audit-compare.sh): an absolute check would be red from the day it lands
   * until the last operation is implemented, and a check that is always red stops being read. This one
   * fails on regression — a newly uncovered operation or a new phantom route — and also fails when an
   * entry has been resolved but left in the file, so the debt list cannot silently go stale.
   */
  baseline: { uncovered: string[]; phantomRoutes: string[] };
}

/** Routes reached through helpers that take their endpoint as a parameter. */
function tableDrivenRoutes(): string[] {
  return [
    ...Object.values(CHART_ENDPOINTS).map((c) => `get ${c.endpoint}`),
    ...INSIGHT_GROUPED_TOOLS.map((t) => `get ${t.endpoint}`),
    ...INSIGHT_NO_X_TOOLS.map((t) => `get ${t.endpoint}`),
    ...EXPORT_TOOLS.map((t) => `get /data/export/${t.entity}`),
    ...COLLECT_SPLITS_ROUTES.map((route) => `get ${route}`),
    ...Object.values(AUTOCOMPLETE_ENTITIES).map((e) => `get ${e.path}`),
    ...CURRENCY_SUBRESOURCES.map((r) => `get /currencies/{p}/${r}`),
  ];
}

function toolSourceFiles(): string[] {
  const dir = new URL('src/tools/', repoRoot);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_') && f !== 'index.ts')
    .map((f) => fileURLToPath(new URL(f, dir)));
}

function main(): number {
  let spec: SpecOperation[];
  let exceptions: ExceptionsFile;
  try {
    spec = parseSpecOperationsChecked(read('spec/firefly-iii-6.5.5-v1.yaml'));
    exceptions = JSON.parse(read('spec/coverage-exceptions.json')) as ExceptionsFile;
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 2;
  }

  // An exception without a written reason is not an exception, it is a swept-under-the-rug failure.
  const unjustified = [...exceptions.uncovered, ...exceptions.phantomRoutes].filter(
    (e) => !e.reason || e.reason.trim() === '',
  );
  if (unjustified.length > 0) {
    console.error(`✗ ${unjustified.length} exception(s) in coverage-exceptions.json have no reason.`);
    return 2;
  }

  const { routes, unresolved } = scanFiles(toolSourceFiles());
  if (unresolved.length > 0) {
    console.error('✗ Unresolvable dynamic routes — coverage cannot be verified:\n');
    for (const u of unresolved) {
      console.error(`    ${u.file.replace(fileURLToPath(repoRoot), '')}:${u.line}  ${u.text}`);
    }
    console.error(
      '\n  Each of these passes its route as a variable. Export the table it is driven by, expand it in\n' +
        '  tableDrivenRoutes(), and add the function to TABLE_DRIVEN_HELPERS. Do not silence this check:\n' +
        '  an unresolved route means the report below would be wrong, not merely incomplete.',
    );
    return 2;
  }

  const called = new Set([...routes.map((r) => `${r.method} ${r.route}`), ...tableDrivenRoutes()]);
  const specRoutes = new Set(spec.map((o) => `${o.method} ${toClientRoute(o.path)}`));

  const excusedIds = new Set(exceptions.uncovered.map((e) => e.operationId));
  const excusedPhantoms = new Set(exceptions.phantomRoutes.map((e) => `${e.method} ${toClientRoute(e.path)}`));

  const baselineIds = new Set(exceptions.baseline?.uncovered ?? []);
  const baselinePhantoms = new Set(exceptions.baseline?.phantomRoutes ?? []);

  const allMissing = spec.filter(
    (o) => !called.has(`${o.method} ${toClientRoute(o.path)}`) && !excusedIds.has(o.operationId),
  );
  const allPhantoms = [...called].filter((r) => !specRoutes.has(r) && !excusedPhantoms.has(r));

  // Regressions: not covered, and not already known debt.
  const missing = allMissing.filter((o) => !baselineIds.has(o.operationId));
  const phantoms = allPhantoms.filter((r) => !baselinePhantoms.has(r));

  // Stale debt: listed as outstanding but actually resolved. Left unchecked, the baseline would keep
  // excusing operations that are already covered, and the remaining figure would drift from reality.
  const nowCovered = [...baselineIds].filter((id) => !allMissing.some((o) => o.operationId === id));
  const nowAbsent = [...baselinePhantoms].filter((r) => !allPhantoms.includes(r));

  if (missing.length > 0) {
    const byTag = new Map<string, SpecOperation[]>();
    for (const op of missing) {
      const tag = op.path.split('/')[2] ?? 'other';
      byTag.set(tag, [...(byTag.get(tag) ?? []), op]);
    }
    console.log(`\nNewly uncovered operations — not in the baseline (${missing.length}):\n`);
    for (const [tag, ops] of [...byTag].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${tag} (${ops.length})`);
      for (const op of ops) console.log(`    ${op.method.toUpperCase().padEnd(6)} ${op.path}  ${op.operationId}`);
    }
  }

  if (phantoms.length > 0) {
    console.log(`\nNew phantom routes — called by the code, absent from the spec (${phantoms.length}):\n`);
    for (const r of phantoms.sort()) {
      const site = routes.find((x) => `${x.method} ${x.route}` === r);
      const where = site ? ` (${site.file.replace(fileURLToPath(repoRoot), '')}:${site.line})` : '';
      console.log(`    ${r}${where}`);
    }
    console.log(
      '\n  Verify each against a live instance before removing the tool: Firefly III keeps undocumented\n' +
        '  compatibility routes. Record the verdict in spec/coverage-exceptions.json either way.',
    );
  }

  if (nowCovered.length > 0 || nowAbsent.length > 0) {
    console.log('\nResolved, but still listed in baseline — remove these entries:\n');
    for (const id of nowCovered.sort()) console.log(`    uncovered: ${id}`);
    for (const r of nowAbsent.sort()) console.log(`    phantomRoutes: ${r}`);
  }

  const outstanding = allMissing.length;
  const excused = excusedIds.size > 0 ? `, ${excusedIds.size} documented exception(s)` : '';
  console.log(
    `\nCoverage: ${spec.length - outstanding}/${spec.length} operations${excused}; ` +
      `${allPhantoms.length} phantom route(s). ` +
      `Baseline debt: ${outstanding} uncovered, ${allPhantoms.length} phantom.`,
  );
  if (missing.length === 0 && phantoms.length === 0 && nowCovered.length === 0 && nowAbsent.length === 0) {
    console.log('No regression against the recorded baseline.');
  }

  return missing.length > 0 || phantoms.length > 0 || nowCovered.length > 0 || nowAbsent.length > 0 ? 1 : 0;
}

process.exit(main());
