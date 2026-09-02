import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * THE PRODUCTION CLIENT MUST PASS `prepare: false`.
 *
 * `client.prepared-commit.integration.test.ts` characterises the *driver hazard* — it builds
 * its own clients with explicit options to demonstrate that a named `COMMIT` is silently
 * rolled back across a pooler backend hand-over. What it does NOT do is touch
 * `client.ts`, so deleting `prepare: false` from the production client leaves that suite
 * entirely green. This test is the missing half: the regression guard on the config line.
 *
 * WHY IT MATTERS. postgres-js issues its own transaction control as a tagged template —
 * ``sql`commit` `` — which is prepared and given a server-side NAME cached per socket. The apps
 * connect through Supabase's TRANSACTION-mode pooler, so a later transaction can meet a backend
 * that never parsed that name (26000). postgres-js lists `FetchPreparedStatement` in its
 * `retryRoutines`, so instead of rejecting it RE-EXECUTES the COMMIT inside the now-aborted
 * block; Postgres permits that, rolls back, and answers with the tag ROLLBACK and no error.
 * `db.transaction()` then RESOLVES with every write discarded.
 *
 * That silently destroyed a real A$300 wallet credit: ledger entry applied and logged, wallet
 * updated, HTTP 200 acked to Stripe, and nothing persisted — not even the webhook marker.
 * Because the ack was 200, Stripe never redelivered, so the loss was permanent.
 *
 * A source scan rather than a runtime assertion on purpose: `db` initialises eagerly against
 * `DATABASE_URL`, which is absent in unit-test environments, and drizzle does not surface the
 * underlying driver options through a stable public API.
 */

const CLIENT_SOURCE = fileURLToPath(new URL('../client.ts', import.meta.url));

describe('the production postgres-js client', () => {
  it('constructs with prepare: false', () => {
    const source = stripComments(readFileSync(CLIENT_SOURCE, 'utf8'));

    // The construction call must carry the option. Deliberately simple patterns (no nested
    // quantifiers) so they stay SonarCloud S5852-safe.
    expect(source).toMatch(/postgres\s*\(\s*connectionString\s*,/);
    expect(source).toMatch(/prepare\s*:\s*false/);
  });

  it('never constructs the client with prepared statements left on', () => {
    const source = stripComments(readFileSync(CLIENT_SOURCE, 'utf8'));

    // `postgres(connectionString)` with no options is the defect: postgres-js defaults
    // `prepare` to true. This is the exact line that shipped and lost money.
    expect(source).not.toMatch(/postgres\s*\(\s*connectionString\s*\)/);
    expect(source).not.toMatch(/prepare\s*:\s*true/);
  });
});
