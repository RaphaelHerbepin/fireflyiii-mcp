# Local development stack

`docker-compose.dev.yml` brings up a throwaway Firefly III, its database, and this MCP server, so you
can develop against a real API without touching a real instance.

It is deliberately isolated: the Compose project is named `fireflyiii-mcp-dev`, storage is named
volumes rather than bind mounts, and the Firefly image is pinned to `version-6.5.5` — the version the
vendored OpenAPI spec describes. Pointing a dev stack at a bind mount is how one eats real data, and
running it on `:latest` means testing against an API the tools were not written for.

## Bring it up

```bash
docker compose -f docker-compose.dev.yml up -d
```

Firefly answers `/healthcheck` before its migrations finish, so the token script waits for both.

## Get a token

```bash
CONTAINER=fireflyiii-dev scripts/ci-create-token.sh http://localhost:8080
```

This is the same script CI uses for nightly integration runs; `CONTAINER` selects which container to
talk to. It creates a user, a Passport personal access client, and prints a token on stdout.

Copy `.env.dev.example` to `.env.dev` and paste the token in.

## Seed it

```bash
npx tsx scripts/seed-dev-data.ts --url http://localhost:8080 --token <PAT>
```

Roughly 2 000 transactions across 18 months: four asset accounts, a liability used for a
four-instalment purchase, the five real budget names, fifteen categories, some tagged transactions, a
few deliberately left without category or budget, a handful in USD, and monthly budget limits.

Two properties make it useful rather than merely large:

- **Deterministic.** A fixed seed produces the same dataset every run, so tests can assert absolute
  figures. Pass `--seed` to vary it, `--count` for a smaller set while iterating.
- **Self-describing.** While generating, it sums the totals in integer cents and writes them to
  `spec/seed-manifest.json`. Aggregation tools are then checked against an oracle computed
  independently of the API — a test that re-sums what the API returned validates a wrong total just as
  happily as a right one.

It refuses to run against an instance that already holds seeded data; `--force` purges first. Every
transaction carries an `external_id` of `seed:<n>`, so nothing it did not create is ever touched.

## Run the integration tests against it

```bash
npm run test:integration        # reads .env.test
```

Point `.env.test` at the dev stack. Tests needing the seeded dataset are additionally gated on
`FIREFLY_SEEDED=true`, so an empty instance runs the rest without failing.

## Tear it down

```bash
docker compose -f docker-compose.dev.yml down -v
```

`-v` removes the volumes. Because the project is namespaced, this cannot reach another stack.
