# apiroc-probe — BAL-393 spike harness

Throwaway harness that exercises the **Apiroc (OneCal) Unified Calendar API sandbox** to
capture runtime behaviour the docs do not specify. The deliverable is
[`FINDINGS.md`](./FINDINGS.md); this code is disposable and **must not be merged to main**.

Deliberately outside the pnpm workspace (`pnpm-workspace.yaml` globs only `apps/*` and
`packages/*`), so it never enters the monorepo install, build, or CI graph.

## Setup

```bash
cd spikes/apiroc-probe
cp .env.example .env      # then fill in APIROC_API_KEY + APIROC_APP_ID
pnpm install
```

`.env` is git-ignored (here and at the repo root). The harness redacts the API key from
every capture file and every line it prints — captures record _which_ auth mode a probe
used, never the key itself.

## Phases

| Phase | Command                                   | Needs                               |
| ----- | ----------------------------------------- | ----------------------------------- |
| 0     | `pnpm phase0`                             | API key only — runnable immediately |
| 0     | `pnpm phase0:rate-limit`                  | as above, plus burns sandbox quota  |
| 1     | `pnpm authorize-url google` / `microsoft` | a browser consent click by Yomi     |
| 2     | _(not yet written)_                       | public HTTPS receiver (cloudflared) |

Phase 0 probes each failure **twice** — once with raw `fetch` to capture the true wire
envelope, HTTP status and headers, and once through the SDK to capture how it normalises
them. The adapter branches on the SDK half; the raw half shows what the SDK drops.

> **SDK note:** the ticket pins `@onecal/unified-calendar-api-node-sdk@1.2.0`. That package
> is **deprecated**; it was republished as `@apiroc/unified-calendar-api-node-sdk@2.0.1` on
> 2026-08-05. This harness uses v2. See `FINDINGS.md` → Finding 0.

## Do not

Touch `packages/db`, mappers, or `tests/invariants/`. Use production keys or real expert
data. Commit `.env`. Build any part of the real adapter off the back of this.
