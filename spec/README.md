# Vendored Firefly III OpenAPI spec

`firefly-iii-6.5.5-v1.yaml` is the authoritative reference for every tool in this repository.
Field names in Firefly III's narrative documentation regularly diverge from what the API actually
accepts, so the spec — not the docs — decides.

| | |
|---|---|
| Version | 6.5.5 (API v1) |
| Source | https://api-docs.firefly-iii.org/firefly-iii-6.5.5-v1.yaml |
| Retrieved | 2026-08-21 |
| SHA-256 | `906276730447be340823e467134138fefd54320ddc53b47682b2f5d79b8e9fc8` |
| Size |   784112 bytes |
| Contents | 230 operations across 164 paths |

The upstream host rejects default user agents; fetch it with an explicit one:

```bash
curl -s -A "Mozilla/5.0 (Macintosh)" \
  "https://api-docs.firefly-iii.org/firefly-iii-6.5.5-v1.yaml" \
  -o spec/firefly-iii-6.5.5-v1.yaml
```

## Why it is vendored rather than fetched

`scripts/check-api-coverage.ts` runs in CI on every pull request. Fetching the spec per run would
make the build depend on a third-party host and, worse, let coverage silently change without a commit.
The checked-in copy makes any spec change a reviewable diff.

The operation and path counts above are asserted at parse time. If upstream republishes 6.5.5 with a
different shape, the parser fails loudly instead of reporting a coverage figure derived from a file it
no longer understands. `nightly.yml` re-fetches the spec and compares the SHA-256 as a warning-only
step, so a silent upstream republish is noticed.

## Companion files

- `coverage-exceptions.json` — operations deliberately left uncovered, and routes the code calls that
  the spec does not define. Every entry carries a written reason; the check fails on an empty one.
