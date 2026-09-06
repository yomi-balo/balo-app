import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * BAL-540 (orchestrator D4) — THE ONE HAZARD NO RUNTIME TEST IN THIS PACKAGE CAN SEE,
 * encoded as a source scan.
 *
 * `projectRequestsRepository.close()` must run in EXACTLY ONE `db.transaction`. Calling a
 * repository method that opens ITS OWN transaction from inside it —
 * `meetingsRepository.cancel`, `proposalsRepository.transitionStatus`,
 * `requestExpertRelationshipsRepository.transitionStatus`, or
 * `requestExpertRelationshipsRepository.declineTrack` — takes a SECOND POOLED CONNECTION in
 * production and commits INDEPENDENTLY of the close. A rolled-back close would then leave the
 * meetings cancelled, the tracks declined and the request still open.
 *
 * ⚠⚠ WHY THIS IS A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. The integration harness swaps the
 * base `db` for the outer transaction handle (`test/setup-integration.ts`), so a nested
 * `db.transaction()` becomes a SAVEPOINT on the SAME connection and behaves correctly; and the
 * pool is pinned at `max: 1` (memory `reference_db_integration_harness_no_concurrency`), so a
 * genuine second-connection race is inexpressible. A GREEN INTEGRATION SUITE WOULD NOT CATCH
 * THE MISTAKE. Review plus this file are the only guards, which is exactly why the file
 * exists: it turns a reviewable rule into a mechanical one.
 *
 * The fix, if this fails, is NOT to relax the assertion. It is to call the `DbExecutor`-taking
 * primitive instead: `cancelMeetingTx`, `advanceProposalStatus`, `advanceRelationshipStatus`.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST, and that is load-bearing: `close()`'s own docblock NAMES all
 * four forbidden call sites in order to explain that they are absent. Without the stripper this
 * invariant would fail on the prose that documents it (the `repositories-never-notify.test.ts`
 * shape, verbatim).
 */
const SOURCE_FILE = 'project-requests.ts';

/**
 * The tx-OPENING wrappers. Every one of these calls `db.transaction` internally, so every one
 * of them is a second connection when called from inside another transaction.
 */
const FORBIDDEN_INSIDE_CLOSE: readonly string[] = [
  'meetingsRepository.cancel',
  'proposalsRepository.transitionStatus',
  'requestExpertRelationshipsRepository.transitionStatus',
  'requestExpertRelationshipsRepository.declineTrack',
  'representationsRepository.revoke(',
];

const source = stripComments(
  readFileSync(fileURLToPath(new URL(`../repositories/${SOURCE_FILE}`, import.meta.url)), 'utf8')
);

/**
 * The body of `async close(...)`, from its declaration to the closing `},` of the method.
 * Located by brace-matching from the first `{` after the signature rather than by regex, so a
 * nested object literal or arrow body cannot end the slice early.
 */
function closeMethodBody(): string {
  const start = source.indexOf('async close(');
  if (start === -1) {
    throw new Error(
      `${SOURCE_FILE} no longer declares \`async close(\`. If the cascade moved, MOVE THIS INVARIANT WITH IT — do not delete it.`
    );
  }
  const bodyStart = source.indexOf('{', source.indexOf('=>', start) === -1 ? start : start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart, i + 1);
      }
    }
  }
  throw new Error(`Could not brace-match the body of close() in ${SOURCE_FILE}.`);
}

const body = closeMethodBody();

describe('invariant: BAL-540 close() opens exactly one transaction (D4)', () => {
  it('guards the guard — the extracted body is non-empty and is really the cascade', () => {
    expect(body.length).toBeGreaterThan(500);
    // If these three disappear the slice is not the cascade and every assertion below is
    // vacuous. They are the cascade's three unmistakable steps.
    expect(body).toContain('cancelMeetingTx');
    expect(body).toContain('advanceRelationshipStatus');
    expect(body).toContain("action: 'project_request.closed'");
  });

  it('opens EXACTLY ONE db.transaction', () => {
    const occurrences = body.split('db.transaction(').length - 1;
    expect(
      occurrences,
      `close() contains ${occurrences} \`db.transaction(\` calls. It must open exactly one: ` +
        `every write in the cascade commits or rolls back with the request row.`
    ).toBe(1);
  });

  it.each(FORBIDDEN_INSIDE_CLOSE)('never calls the tx-opening wrapper %s', (wrapper) => {
    expect(
      body.includes(wrapper),
      `close() calls ${wrapper}, which opens its OWN db.transaction — a SECOND pooled ` +
        `connection in production, committing independently of the close. Use the ` +
        `DbExecutor-taking primitive instead (cancelMeetingTx / advanceProposalStatus / ` +
        `advanceRelationshipStatus / revokeAllForRequest). ⚠ The integration harness turns ` +
        `nested transactions into SAVEPOINTs, so no runtime test would have caught this.`
    ).toBe(false);
  });

  it('drives the meeting flip through the shared DbExecutor core, not a second copy of the CAS', () => {
    // The positive half of the rule: it is not enough to avoid `meetingsRepository.cancel` —
    // duplicating its compare-and-set here would give the codebase two definitions of
    // "cancellable", which is precisely what `@balo/shared/meetings/cancellable.ts` exists to
    // prevent. The cascade must go through the ONE extracted core.
    expect(body).toContain('cancelMeetingTx(tx,');
    expect(body).not.toContain('CANCELLABLE_MEETING_STATUSES');
  });
});
