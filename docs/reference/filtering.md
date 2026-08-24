# Tool filtering

With 207 tools across 20 groups, loading everything consumes significant context window space. Three flags let you control exactly which tools are registered.

## --preset \<name\>

Load a named subset of tool groups. Pick by what you ask about, not by what exists:

| Preset | Tools | `tools/list` | Choose it when |
|--------|-------|--------------|----------------|
| `minimal` | 19 | ~5 200 tokens | Accounts and transactions only |
| `default` | 54 | ~13 200 tokens | General use — adds budgets, categories, bills, aggregates |
| **`budgeting`** | **61** | **~14 700 tokens** | **The sensible default.** Adds savings goals to `default` |
| `insights` | 68 | ~14 300 tokens | Analysis-heavy — swaps budgets and bills for the report suite |
| `automation` | 54 | ~13 700 tokens | Maintaining rules, recurring transactions and webhooks |
| `full` | 207 | ~41 000 tokens | Exploring what exists. Not for daily use. |

Every preset includes the `search` group, so `search_entities` is always available to resolve a name
to an ID without listing an entire collection.

### What each preset contains

| Preset | Groups |
|--------|--------|
| `minimal` | search, accounts, transactions |
| `default` | search, accounts, transactions, budgets, categories, bills, aggregates |
| `budgeting` | search, accounts, transactions, budgets, categories, bills, piggy-banks, aggregates |
| `insights` | search, accounts, transactions, categories, reports, aggregates |
| `automation` | search, accounts, transactions, rules, recurring, webhooks |
| `full` | every group except `admin-destructive` |

```bash
node dist/index.js --preset default
npx @raphaelherbepin/fireflyiii-mcp --preset budgeting
```

## --groups \<list\>

Comma-separated list of specific groups. Cannot combine with `--preset`.

Valid group names: `accounts`, `aggregates`, `search`, `transactions`, `budgets`, `categories`, `bills`, `piggy-banks`, `reports`, `rules`, `recurring`, `attachments`, `currencies`, `exports`, `object-groups`, `transaction-links`, `webhooks`, `exchange-rates`, `admin`, `admin-destructive`

```bash
node dist/index.js --groups accounts,transactions,reports
```

## --read-only

Filter any selection down to tools that only read. Write tools are **not registered at all**, so a
client cannot call them — it never learns they exist. That is a stronger guarantee than telling a
model not to write.

Which tools survive is decided by each tool's `readOnlyHint` annotation, not by its name. That
distinction matters: the nine `export_*` tools and `download_attachment` only read, and a
name-prefix rule used to drop all ten.

| Preset | Read-only | Full access | Write tools withheld |
|--------|-----------|-------------|----------------------|
| `minimal` | 10 | 19 | 9 |
| `default` | 33 | 54 | 21 |
| `budgeting` | 37 | 61 | 24 |
| `insights` | 53 | 68 | 15 |
| `automation` | 26 | 54 | 28 |
| `full` | 127 | 207 | 80 |

Combines with `--preset` or `--groups`.

```bash
node dist/index.js --preset default --read-only
node dist/index.js --groups rules --read-only
```

Without any filter flags the server registers all 207 tools (equivalent to `--preset full`).

::: warning `full` is for exploration, not daily use
Every tool definition costs context before a single call is made. Measured by
`scripts/check-tool-counts.sh`:

| Preset | Tools | `tools/list` cost |
|--------|-------|-------------------|
| `minimal` | 19 | ~5 200 tokens |
| `default` | 54 | ~13 200 tokens |
| `budgeting` | 61 | ~14 700 tokens |
| `insights` | 68 | ~14 300 tokens |
| `automation` | 54 | ~13 700 tokens |
| `full` | 207 | ~41 000 tokens |

`full` spends roughly 41 000 tokens of every conversation restating tools you will not call. Use it to
find out what exists, then pick a preset. **For a Claude connector, `budgeting` is the sensible
default**: accounts, transactions, budgets, categories, bills, piggy banks, search and the aggregate
tools, for about a third of the cost.

`full` also excludes `admin-destructive`. Asking for every tool is asking to see what the server can
do, not asking to be handed something that permanently erases an accounting history — those two tools
need `--groups admin-destructive` naming them explicitly.
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
