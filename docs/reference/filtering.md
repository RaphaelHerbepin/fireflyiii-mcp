# Tool filtering

With 146 tools across 15 groups, loading everything consumes significant context window space. Three flags let you control exactly which tools are registered.

## --preset \<name\>

Load a named subset of tool groups:

| Preset | Groups included | Tools |
|--------|----------------|-------|
| `minimal` | accounts, transactions | 15 |
| `default` | accounts, transactions, budgets, categories, bills, aggregates | 43 |
| `budgeting` | accounts, transactions, budgets, categories, bills, piggy-banks, aggregates | 50 |
| `insights` | accounts, transactions, categories, reports, aggregates | 63 |
| `automation` | accounts, transactions, rules, recurring | 37 |
| `full` | all 15 groups | 146 |

```bash
node dist/index.js --preset default
npx @raphaelherbepin/fireflyiii-mcp --preset budgeting
```

## --groups \<list\>

Comma-separated list of specific groups. Cannot combine with `--preset`.

Valid group names: `accounts`, `aggregates`, `transactions`, `budgets`, `categories`, `bills`, `piggy-banks`, `reports`, `rules`, `recurring`, `attachments`, `currencies`, `exports`, `object-groups`, `transaction-links`

```bash
node dist/index.js --groups accounts,transactions,reports
```

## --read-only

Filter any selection down to read-only tools (`get_*`, `search_*`, `test_*`). All create, update, delete, trigger, and upload tools are excluded. Can combine with `--preset` or `--groups`.

```bash
node dist/index.js --preset default --read-only
node dist/index.js --groups rules --read-only
```

Without any filter flags the server registers all 146 tools (equivalent to `--preset full`).

::: warning `full` is for exploration, not daily use
Every tool definition costs context before a single call is made. Measured with
`scripts/check-tool-counts.sh`:

| Preset | Tools | `tools/list` cost |
|--------|-------|-------------------|
| `minimal` | 15 | ~4 200 tokens |
| `default` | 43 | ~10 700 tokens |
| `budgeting` | 50 | ~12 000 tokens |
| `insights` | 63 | ~13 100 tokens |
| `automation` | 37 | ~10 200 tokens |
| `full` | 146 | ~29 300 tokens |

`full` spends roughly 29 000 tokens of every conversation restating tools you will not call. Use it to
find out what exists, then pick a preset. **For a Claude connector, `budgeting` is the sensible
default**: it covers accounts, transactions, budgets, categories, bills, piggy banks and the aggregate
tools for about 40% of the cost.
:::

## Environment variable equivalents

Each flag has an environment variable fallback, useful for npm/stdio and Docker setups where there's no natural place to pass CLI flags. The CLI flag always takes precedence.

| Variable | Equivalent flag | Example |
|----------|-----------------|---------|
| `MCP_PRESET` | `--preset <name>` | `MCP_PRESET=default` |
| `MCP_GROUPS` | `--groups <list>` | `MCP_GROUPS=accounts,transactions` |
| `MCP_READ_ONLY` | `--read-only` | `MCP_READ_ONLY=true` (also accepts `1`) |

`MCP_PRESET` and `MCP_GROUPS` are mutually exclusive.

### In stdio MCP config

```json
"env": {
  "FIREFLY_URL": "https://your-firefly-instance.example.com",
  "FIREFLY_TOKEN": "your-personal-access-token-here",
  "MCP_PRESET": "default",
  "MCP_READ_ONLY": "true"
}
```

### In Docker

```bash
docker run \
  -e FIREFLY_URL=https://... \
  -e FIREFLY_OAUTH_CLIENT_ID=... \
  -e MCP_BASE_URL=https://... \
  -e MCP_PRESET=default \
  -e MCP_READ_ONLY=true \
  -p 3000:3000 \
  ghcr.io/raphaelherbepin/fireflyiii-mcp:latest
```
