#!/usr/bin/env tsx
/**
 * Populates a Firefly III instance with a realistic dataset for developing and testing against.
 *
 * Two properties matter more than the data itself:
 *
 *  1. **Deterministic.** A fixed seed produces the same dataset every run, so tests can assert
 *     absolute figures rather than re-summing what the API returned and comparing it to itself.
 *  2. **Self-describing.** While generating, it computes the totals in integer cents and writes them
 *     to spec/seed-manifest.json. The aggregation tools are then checked against an oracle built
 *     independently of the API — a test that re-sums API output validates a wrong total just as
 *     happily as a right one.
 *
 * Refuses to run against an instance that already holds seeded data unless --force is given, and
 * never touches anything it did not create: every transaction carries an `external_id` of `seed:<n>`.
 *
 *   npx tsx scripts/seed-dev-data.ts --url http://localhost:8080 --token <PAT>
 *   npx tsx scripts/seed-dev-data.ts --count 200        # smaller set while iterating
 */

import { writeFileSync } from 'node:fs';
import { FireflyClient } from '../src/client.js';
import { createPrng } from './lib/prng.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_SEED = 20260821;
const DEFAULT_COUNT = 2000;
const MONTHS = 18;
const CONCURRENCY = 8;
const SEED_PREFIX = 'seed:';

/**
 * Object types to purge under --force, in dependency order. Firefly III scopes `objects=accounts` to
 * expense accounts only, so clearing an instance takes one call per account family — a single call
 * looks like it worked and then the next seed fails on duplicate account names.
 */
const PURGE_ORDER = [
  'transactions',
  'piggy_banks',
  'budgets',
  'categories',
  'tags',
  'object_groups',
  'recurring',
  'rules',
  'bills',
  'asset_accounts',
  'expense_accounts',
  'revenue_accounts',
  'liabilities',
  'accounts',
] as const;

/** The user's real budget names — the dataset is only useful if it mirrors the real shape. */
const BUDGETS = [
  'Fixes incompressibles',
  'Variables essentielles',
  'Plaisirs et loisirs',
  'Autres dépenses',
  'Épargnes et investissements',
] as const;

const CATEGORIES = [
  'Alimentation',
  'Restaurants',
  'Transport',
  'Carburant',
  'Logement',
  'Électricité',
  'Internet & téléphone',
  'Assurances',
  'Santé',
  'Vêtements',
  'Loisirs',
  'Abonnements',
  'Cadeaux',
  'Voyages',
  'Frais bancaires',
] as const;

const TAGS = ['récurrent', 'exceptionnel', 'professionnel', 'remboursable', 'vacances'] as const;

/** Expense accounts, with the budget and category a purchase there usually falls under. */
const MERCHANTS: ReadonlyArray<{ name: string; budget: number; category: number; min: number; max: number }> = [
  { name: 'Coopérative U', budget: 1, category: 0, min: 1200, max: 14000 },
  { name: 'Carrefour', budget: 1, category: 0, min: 900, max: 11000 },
  { name: 'Boulangerie du coin', budget: 1, category: 0, min: 200, max: 1800 },
  { name: 'Le Bistrot', budget: 2, category: 1, min: 1500, max: 8000 },
  { name: 'SNCF', budget: 1, category: 2, min: 1000, max: 15000 },
  { name: 'Total Énergies', budget: 1, category: 3, min: 4000, max: 9000 },
  { name: 'Agence immobilière', budget: 0, category: 4, min: 75000, max: 75000 },
  { name: 'EDF', budget: 0, category: 5, min: 6000, max: 14000 },
  { name: 'Free Mobile', budget: 0, category: 6, min: 1999, max: 1999 },
  { name: 'MAIF', budget: 0, category: 7, min: 3500, max: 3500 },
  { name: 'Pharmacie centrale', budget: 1, category: 8, min: 800, max: 6000 },
  { name: 'Decathlon', budget: 2, category: 9, min: 2000, max: 12000 },
  { name: 'Cinéma Le Rex', budget: 2, category: 10, min: 900, max: 2400 },
  { name: 'Netflix', budget: 2, category: 11, min: 1399, max: 1399 },
  { name: 'Amazon', budget: 3, category: 12, min: 1500, max: 9000 },
  { name: 'Booking.com', budget: 2, category: 13, min: 8000, max: 45000 },
  { name: 'Banque Populaire', budget: 3, category: 14, min: 500, max: 1200 },
];

// ── CLI ───────────────────────────────────────────────────────────────────────

interface Options {
  url: string;
  token: string;
  seed: number;
  count: number;
  force: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get('--url') ?? process.env.FIREFLY_URL ?? 'http://localhost:8080';
  const token = get('--token') ?? process.env.FIREFLY_TOKEN ?? '';
  if (!token) {
    throw new Error(
      'A Firefly III personal access token is required: pass --token, or set FIREFLY_TOKEN.\n' +
        'For the dev stack: CONTAINER=fireflyiii-dev scripts/ci-create-token.sh http://localhost:8080',
    );
  }
  return {
    url,
    token,
    seed: Number(get('--seed') ?? DEFAULT_SEED),
    count: Number(get('--count') ?? DEFAULT_COUNT),
    force: argv.includes('--force'),
  };
}

// ── Money, in integer cents throughout ────────────────────────────────────────

/** Cents → the decimal string the API expects. Amounts are always positive; `type` carries direction. */
const toAmount = (cents: number): string => (cents / 100).toFixed(2);

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Created {
  id: string;
  name: string;
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const progress = (done: number, total: number, label: string): void => {
  if (done % 100 === 0 || done === total) {
    process.stderr.write(`\r  ${label}: ${done}/${total}`);
    if (done === total) process.stderr.write('\n');
  }
};

// ── Manifest: the independent oracle ──────────────────────────────────────────

interface Manifest {
  seed: number;
  generatedFrom: { months: number; transactions: number };
  currency: string;
  /** Every figure in integer cents, summed as the data was generated — never read back from the API. */
  totals: {
    withdrawalCents: number;
    depositCents: number;
    transferCents: number;
    byBudget: Record<string, number>;
    byCategory: Record<string, number>;
    byMonth: Record<string, number>;
    byBudgetByMonth: Record<string, Record<string, number>>;
  };
  counts: {
    total: number;
    withdrawals: number;
    deposits: number;
    transfers: number;
    splits: number;
    uncategorised: number;
    unbudgeted: number;
  };
}

const add = (bucket: Record<string, number>, key: string, cents: number): void => {
  bucket[key] = (bucket[key] ?? 0) + cents;
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const client = new FireflyClient(options.url, options.token);
  const rng = createPrng(options.seed);

  process.stderr.write(`Seeding ${options.url} (seed ${options.seed}, ${options.count} transactions)\n`);

  // Refuse to add a second dataset on top of an existing one.
  const existing = await client.get<{ data: unknown[] }>('/search/transactions', {
    query: SEED_PREFIX,
    limit: 1,
  });
  if (existing.data.length > 0 && !options.force) {
    process.stderr.write(
      'This instance already holds seeded data. Re-running would double it.\n' +
        'Pass --force to purge everything first.\n',
    );
    return 1;
  }
  // Purge unconditionally under --force, not only when seeded transactions are found. A previous run
  // that failed part-way leaves accounts behind with no transactions, and keying the purge on
  // transactions alone means --force reports success and then collides on duplicate account names.
  if (options.force) {
    process.stderr.write('  --force: purging existing data…\n');
    // One pass per object type, in dependency order. `objects=accounts` alone only clears expense
    // accounts, so a single call leaves asset, revenue and liability accounts behind and the next run
    // fails on duplicate names. Verified against 6.5.5.
    for (const objects of PURGE_ORDER) {
      await client.delete('/data/destroy', { objects });
    }
  }

  // ── Accounts ────────────────────────────────────────────────────────────────
  const assetSpecs = [
    { name: 'Compte courant', role: 'defaultAsset', opening: 250000 },
    { name: 'Livret A', role: 'savingAsset', opening: 800000 },
    { name: 'Espèces', role: 'cashWalletAsset', opening: 15000 },
    // AccountRoleProperty has no 'shares' role; defaultAsset is the closest honest fit.
    { name: 'Compte-titres', role: 'defaultAsset', opening: 1200000 },
  ];

  const assets: Created[] = await mapLimited(assetSpecs, CONCURRENCY, async (spec) => {
    const res = await client.post<{ data: { id: string } }>('/accounts', {
      name: spec.name,
      type: 'asset',
      account_role: spec.role,
      currency_code: 'EUR',
      opening_balance: toAmount(spec.opening),
      opening_balance_date: '2025-01-01',
    });
    return { id: res.data.id, name: spec.name };
  });
  process.stderr.write(`  accounts: ${assets.length} asset\n`);

  // A USD account so multi-currency guards have something to guard.
  const usdAccount = await client
    .post<{ data: { id: string } }>('/accounts', {
      name: 'Compte USD',
      type: 'asset',
      account_role: 'defaultAsset',
      currency_code: 'USD',
      opening_balance: '1000.00',
      opening_balance_date: '2025-01-01',
    })
    .then((r) => ({ id: r.data.id, name: 'Compte USD' }));

  const liabilities: Created[] = await mapLimited(
    [
      { name: 'Paiements fractionnés', type: 'debt', amount: 0 },
      { name: 'Prêt auto', type: 'loan', amount: 950000 },
    ],
    CONCURRENCY,
    async (spec) => {
      const res = await client.post<{ data: { id: string } }>('/accounts', {
        name: spec.name,
        type: 'liability',
        liability_type: spec.type,
        liability_direction: 'debit',
        currency_code: 'EUR',
        opening_balance: toAmount(-spec.amount),
        opening_balance_date: '2025-01-01',
        interest: '0',
        interest_period: 'monthly',
      });
      return { id: res.data.id, name: spec.name };
    },
  );

  const revenue = await client
    .post<{ data: { id: string } }>('/accounts', {
      name: 'Employeur',
      type: 'revenue',
      currency_code: 'EUR',
    })
    .then((r) => ({ id: r.data.id, name: 'Employeur' }));

  const merchants: Created[] = await mapLimited(MERCHANTS, CONCURRENCY, async (m) => {
    const res = await client.post<{ data: { id: string } }>('/accounts', {
      name: m.name,
      type: 'expense',
      currency_code: 'EUR',
    });
    return { id: res.data.id, name: m.name };
  });
  process.stderr.write(`  accounts: ${merchants.length} expense, ${liabilities.length} liability, 1 revenue\n`);

  // ── Budgets and categories ──────────────────────────────────────────────────
  const budgets: Created[] = await mapLimited([...BUDGETS], CONCURRENCY, async (name) => {
    const res = await client.post<{ data: { id: string } }>('/budgets', { name, active: true });
    return { id: res.data.id, name };
  });

  const categories: Created[] = await mapLimited([...CATEGORIES], CONCURRENCY, async (name) => {
    const res = await client.post<{ data: { id: string } }>('/categories', { name });
    return { id: res.data.id, name };
  });
  process.stderr.write(`  ${budgets.length} budgets, ${categories.length} categories\n`);

  // Monthly budget limits, so budget-performance tooling has limits to compare against.
  const limitCents = [95000, 60000, 40000, 25000, 50000];
  const limitJobs: Array<{ budget: Created; month: number }> = [];
  for (let m = 0; m < MONTHS; m++) for (const budget of budgets) limitJobs.push({ budget, month: m });
  await mapLimited(limitJobs, CONCURRENCY, async ({ budget, month }) => {
    const start = new Date(Date.UTC(2025, month, 1));
    const end = new Date(Date.UTC(2025, month + 1, 0));
    await client.post(`/budgets/${budget.id}/limits`, {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      amount: toAmount(limitCents[budgets.indexOf(budget)]),
      currency_code: 'EUR',
    });
  });
  process.stderr.write(`  ${limitJobs.length} budget limits\n`);

  // ── Transactions ────────────────────────────────────────────────────────────
  const manifest: Manifest = {
    seed: options.seed,
    generatedFrom: { months: MONTHS, transactions: options.count },
    currency: 'EUR',
    totals: {
      withdrawalCents: 0,
      depositCents: 0,
      transferCents: 0,
      byBudget: {},
      byCategory: {},
      byMonth: {},
      byBudgetByMonth: {},
    },
    counts: {
      total: 0,
      withdrawals: 0,
      deposits: 0,
      transfers: 0,
      splits: 0,
      uncategorised: 0,
      unbudgeted: 0,
    },
  };

  interface Job {
    index: number;
    body: Record<string, unknown>;
  }
  const jobs: Job[] = [];
  const current = assets[0];
  const savings = assets[1];

  const monthKey = (month: number): string => {
    const d = new Date(Date.UTC(2025, month, 1));
    return d.toISOString().slice(0, 7);
  };
  const dateIn = (month: number): string => {
    const last = new Date(Date.UTC(2025, month + 1, 0)).getUTCDate();
    const d = new Date(Date.UTC(2025, month, rng.int(1, last)));
    return d.toISOString().slice(0, 10);
  };

  let index = 0;
  const push = (body: Record<string, unknown>): void => {
    jobs.push({ index, body });
    index++;
  };

  for (let month = 0; month < MONTHS; month++) {
    const mk = monthKey(month);

    // Salary — a deposit, so it never carries a budget.
    const salary = 285000;
    push({
      error_if_duplicate_hash: false,
      apply_rules: false,
      fire_webhooks: false,
      transactions: [
        {
          type: 'deposit',
          date: `${mk}-01`,
          amount: toAmount(salary),
          description: 'Salaire',
          source_id: revenue.id,
          destination_id: current.id,
          category_id: null,
          external_id: `${SEED_PREFIX}${index}`,
        },
      ],
    });
    manifest.totals.depositCents += salary;
    manifest.counts.deposits++;
    add(manifest.totals.byMonth, mk, -salary);

    // Monthly transfer to savings. Firefly rejects a budget on a transfer, so none is set (§12.1).
    const toSavings = 30000;
    push({
      error_if_duplicate_hash: false,
      apply_rules: false,
      fire_webhooks: false,
      transactions: [
        {
          type: 'transfer',
          date: `${mk}-05`,
          amount: toAmount(toSavings),
          description: 'Virement épargne',
          source_id: current.id,
          destination_id: savings.id,
          external_id: `${SEED_PREFIX}${index}`,
        },
      ],
    });
    manifest.totals.transferCents += toSavings;
    manifest.counts.transfers++;

    // Withdrawals for the month.
    const perMonth = Math.floor((options.count - MONTHS * 2) / MONTHS);
    for (let n = 0; n < perMonth; n++) {
      const m = rng.pick(MERCHANTS);
      const merchant = merchants[MERCHANTS.indexOf(m)];
      const cents = rng.int(m.min, m.max);
      const date = dateIn(month);

      // ~4% deliberately left without category and budget, for the uncategorised tooling.
      const bare = rng.chance(0.04);
      const budget = bare ? null : budgets[m.budget];
      const category = bare ? null : categories[m.category];

      // ~1.5% split across two categories within the same budget.
      if (budget && category && rng.chance(0.015)) {
        const half = Math.floor(cents / 2);
        const rest = cents - half;
        const other = categories[rng.int(0, categories.length - 1)];
        push({
          error_if_duplicate_hash: false,
          apply_rules: false,
          fire_webhooks: false,
          group_title: `${m.name} — dépense scindée`,
          transactions: [
            {
              type: 'withdrawal',
              date,
              amount: toAmount(half),
              description: `${m.name} (part 1)`,
              source_id: current.id,
              destination_id: merchant.id,
              budget_id: budget?.id,
              category_id: category?.id,
              external_id: `${SEED_PREFIX}${index}`,
            },
            {
              type: 'withdrawal',
              date,
              amount: toAmount(rest),
              description: `${m.name} (part 2)`,
              source_id: current.id,
              destination_id: merchant.id,
              budget_id: budget?.id,
              category_id: other.id,
              external_id: `${SEED_PREFIX}${index}b`,
            },
          ],
        });
        manifest.counts.splits++;
        add(manifest.totals.byCategory, category.name, half);
        add(manifest.totals.byCategory, other.name, rest);
      } else {
        push({
          error_if_duplicate_hash: false,
          apply_rules: false,
          fire_webhooks: false,
          transactions: [
            {
              type: 'withdrawal',
              date,
              amount: toAmount(cents),
              description: m.name,
              source_id: current.id,
              destination_id: merchant.id,
              budget_id: budget?.id,
              category_id: category?.id,
              tags: rng.chance(0.2) ? [rng.pick(TAGS)] : undefined,
              external_id: `${SEED_PREFIX}${index}`,
            },
          ],
        });
        if (category) add(manifest.totals.byCategory, category.name, cents);
      }

      manifest.totals.withdrawalCents += cents;
      manifest.counts.withdrawals++;
      add(manifest.totals.byMonth, mk, cents);
      if (budget) {
        add(manifest.totals.byBudget, budget.name, cents);
        manifest.totals.byBudgetByMonth[budget.name] ??= {};
        add(manifest.totals.byBudgetByMonth[budget.name], mk, cents);
      } else {
        manifest.counts.unbudgeted++;
      }
      if (!category) manifest.counts.uncategorised++;
    }
  }

  // A four-instalment purchase through the liability account, mirroring the real use case.
  const instalment = 12500;
  for (let i = 0; i < 4; i++) {
    const mk = monthKey(3 + i);
    push({
      error_if_duplicate_hash: false,
      apply_rules: false,
      fire_webhooks: false,
      transactions: [
        {
          type: 'withdrawal',
          date: `${mk}-15`,
          amount: toAmount(instalment),
          description: `Paiement 4x — échéance ${i + 1}/4`,
          source_id: current.id,
          destination_id: liabilities[0].id,
          budget_id: budgets[3].id,
          category_id: categories[12].id,
          external_id: `${SEED_PREFIX}${index}`,
        },
      ],
    });
    manifest.totals.withdrawalCents += instalment;
    manifest.counts.withdrawals++;
    add(manifest.totals.byMonth, mk, instalment);
    add(manifest.totals.byBudget, budgets[3].name, instalment);
    manifest.totals.byBudgetByMonth[budgets[3].name] ??= {};
    add(manifest.totals.byBudgetByMonth[budgets[3].name], mk, instalment);
    add(manifest.totals.byCategory, categories[12].name, instalment);
  }

  // A few USD withdrawals, excluded from the EUR totals on purpose so the multi-currency guards have
  // something to guard. They carry no budget and no category, so they count towards those tallies:
  // the API counts transactions, not transactions-in-one-currency, and an oracle that disagreed with
  // it would be the thing that is wrong.
  for (let i = 0; i < 6; i++) {
    push({
      error_if_duplicate_hash: false,
      apply_rules: false,
      fire_webhooks: false,
      transactions: [
        {
          type: 'withdrawal',
          date: `${monthKey(rng.int(0, MONTHS - 1))}-12`,
          amount: '49.99',
          description: 'Abonnement en USD',
          source_id: usdAccount.id,
          destination_id: merchants[14].id,
          currency_code: 'USD',
          external_id: `${SEED_PREFIX}${index}`,
        },
      ],
    });
    manifest.counts.unbudgeted++;
    manifest.counts.uncategorised++;
  }

  manifest.counts.total = jobs.length;

  process.stderr.write(`  posting ${jobs.length} transactions…\n`);
  let posted = 0;
  const failures: Array<{ index: number; message: string }> = [];
  await mapLimited(jobs, CONCURRENCY, async (job) => {
    try {
      await client.post('/transactions', job.body);
    } catch (err) {
      failures.push({ index: job.index, message: (err as Error).message.slice(0, 200) });
    }
    progress(++posted, jobs.length, 'transactions');
  });

  if (failures.length > 0) {
    process.stderr.write(`\n  ${failures.length} transaction(s) failed. First few:\n`);
    for (const f of failures.slice(0, 5)) process.stderr.write(`    #${f.index}: ${f.message}\n`);
    process.stderr.write('  The manifest is NOT written: its totals would not match the instance.\n');
    return 1;
  }

  writeFileSync('spec/seed-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write('\nWrote spec/seed-manifest.json\n');
  process.stderr.write(
    `  ${manifest.counts.withdrawals} withdrawals, ${manifest.counts.deposits} deposits, ` +
      `${manifest.counts.transfers} transfers, ${manifest.counts.splits} split groups\n` +
      `  ${manifest.counts.uncategorised} uncategorised, ${manifest.counts.unbudgeted} unbudgeted\n` +
      `  total withdrawals: ${toAmount(manifest.totals.withdrawalCents)} EUR\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`\n${err.message}\n`);
    process.exit(1);
  },
);
