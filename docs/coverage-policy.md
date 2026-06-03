# Test Coverage Policy

How Balo measures test coverage for the SonarCloud quality gate, and why integration-test
coverage is unioned into the same scan as unit coverage.

## The gate

SonarCloud enforces **≥ 80 % coverage on new/changed lines** (not absolute project coverage).
The gate is **blame-based**: it looks at the lines your PR adds or modifies under
`sonar.sources`, computes the aggregate covered ratio across the whole diff, and fails if that
aggregate drops below 80 %. Untouched legacy code is never re-measured. This is why CI checks
out with `fetch-depth: 0` — Sonar needs full git history to attribute new lines.

## What feeds the gate

The single SonarCloud scan reads **two** lcov reports, and Sonar **unions** line hits across
them (a line covered in either report counts as covered):

| Report                           | Produced by                      | Covers                                               |
| -------------------------------- | -------------------------------- | ---------------------------------------------------- |
| `coverage/lcov.info`             | `pnpm test:coverage` (unit)      | app + package source exercised by unit tests         |
| `coverage-integration/lcov.info` | `pnpm test:integration:coverage` | `packages/db/src/repositories/**` via Testcontainers |

Both reports emit **repo-root-relative `SF:` paths** (e.g. `SF:packages/db/src/repositories/experts.ts`)
so Sonar (base dir = repo root) resolves them. They are wired into the scan via
`sonar.typescript.lcov.reportPaths` and `sonar.javascript.lcov.reportPaths`
(both = `coverage/lcov.info,coverage-integration/lcov.info` in `sonar-project.properties`).

### CI job graph

```
unit-tests ──────────────┐  (coverage + Codecov; uploads coverage-unit artifact; no Sonar step)
integration-tests ───────┤  (runs WITH coverage; uploads coverage-integration artifact)
                         ▼
                  sonarcloud  (needs: [unit-tests, integration-tests])
                              checkout fetch-depth:0 → download both artifacts → single scan
```

The `sonarcloud` job downloads `coverage-unit` to `coverage/` and `coverage-integration` to
`coverage-integration/`, then runs the one and only SonarCloud scan. It deliberately skips
`pnpm install` and re-running tests — it only needs source plus the two lcov files.

## Why integration coverage must be merged

Repository files under `packages/db/src/repositories/**` are covered **only** by their
`*.integration.test.ts` siblings (real Postgres via Testcontainers), never by unit tests.
If the gate saw only the unit report, those files would appear ~0 % covered and a PR touching
them would be forced to either over-cover them with unit mocks (testing nothing real) or wrongly
exclude touched production code from analysis.

**Policy: do not exclude touched production code; cover it where it is genuinely tested.** That
means generating integration coverage and unioning it into the scan (the chosen option), rather
than adding repository files to `sonar.coverage.exclusions`. This honours the two standing rules:
the SonarCloud new-code gate is on changed lines and we must cover touched production code, and we
take no shortcuts that hide real test debt.

## Audit note (BAL-248)

Before BAL-248, the SonarCloud scan only ever ingested `coverage/lcov.info` from the unit run —
integration coverage was **never uploaded or measured**. Repository files exercised solely by
integration tests therefore showed near-zero coverage to Sonar (e.g. `experts.ts` ~2 %, `users.ts`
~4 %, `payouts.ts` ~14 %). Earlier PRs still passed the 80 %-new-code gate because the gate is a
**whole-diff aggregate**: well-covered non-repo files (routes, schemas, libs with real unit tests)
diluted the low repository lines and kept the aggregate above 80 %. No past PR's gate "leaned on"
measured integration coverage — that coverage was simply invisible. BAL-248 closes the gap so
repository lines count for real.

## Authoring rules

- **New repository file ⇒ companion `*.integration.test.ts`** in the same PR (already required —
  see the drizzle-schema skill's "New Repository File Checklist").
- **Deterministic ordering in tests.** When asserting `ORDER BY created_at DESC`, give fixtures
  explicit distinct `createdAt` values rather than relying on insert order — back-to-back inserts
  tie on `created_at` and flake in CI. Assert strict order (e.g. exact id sequence).
- **Do not break `test.root = repoRoot`** in `packages/db/vitest.config.integration.ts`. That line
  is what makes integration `SF:` paths repo-root-relative. v8 writes `SF:` paths relative to the
  vitest `test.root`, **not** `coverage.root`. If integration coverage is ever run without
  `root: repoRoot`, paths revert to package-relative (`SF:src/repositories/...`) and Sonar silently
  shows the repository files as uncovered again. The root-anchored `include`
  (`packages/db/src/**/*.integration.test.ts`) and absolute `globalSetup`/`setupFiles` exist to
  support that root.

## How to verify a file is counted

- **CI:** the `integration-tests` job runs a "Show integration lcov SF paths" step
  (`grep -m3 '^SF:' coverage-integration/lcov.info`) — its output must read `SF:packages/db/src/...`
  (root-relative). That is the single most important success signal for the merge.
- **SonarCloud UI:** open a repository file that was previously ~2–14 % (e.g.
  `packages/db/src/repositories/experts.ts`). After this change its coverage reflects integration
  hits (high). New-code coverage on a PR that adds no new production lines reads N/A / 100 %.
