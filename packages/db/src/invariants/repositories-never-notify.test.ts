import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * BAL-390 §8.7.4 — D4's contract, encoded as a TEST rather than a comment.
 *
 * `case-engagements.ts`'s `close()` docblock tells every caller (BAL-388's recap action
 * today, BAL-420's sweep next) that it MUST, post-commit, mint a review token and publish
 * `engagement.case_closed` — because **this repository cannot do either itself.** The
 * docblock says a reviewer "can check the ruling still holds by grepping it". This file
 * does the grep, every run, so the ruling cannot quietly stop holding.
 *
 * WHY THE REPOSITORY LAYER MUST NEVER NOTIFY (three independent reasons):
 *   1. **CLAUDE.md**: feature code publishes domain events; it never sends email and never
 *      writes notification tables. A repository is below even feature code.
 *   2. **Dependency direction**: `@balo/db` depends only on `@balo/shared`, `drizzle-orm`
 *      and `postgres`. The publisher lives in `apps/api`. An import here would either not
 *      resolve or would invert the dependency graph — and `@balo/db` is imported by
 *      `apps/web` client-adjacent code, where pulling in a queue client is the
 *      `reference_balo_db_client_bundle_footgun` failure all over again.
 *   3. **Transactionality**: `close()` runs inside `db.transaction`. A publish from in
 *      there would fire before commit and would not roll back if the tx aborted — a
 *      "your case is closed" email about a case that is still open.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST, and that is load-bearing here specifically:
 * `case-engagements.ts`'s docblock NAMES `publishNotificationEvent` and
 * `engagement.case_closed` precisely in order to explain that they are absent. Without
 * the stripper this invariant would fail on the prose that documents it.
 *
 * If this test fails: the publish belongs at the CALL SITE, post-commit — not here.
 */

/**
 * The BAL-390 repository surface. Pinned rather than walked: a directory walk would drag
 * in `notification-log.ts` (which legitimately persists delivery records) and turn this
 * into an allow-list-maintenance chore instead of a contract.
 */
const PINNED_REPOSITORIES: readonly string[] = [
  // The one the plan names: `close()` is the terminal anchor for the case review ask.
  'case-engagements.ts',
  // The project anchor — same contract, same reason.
  'project-engagements.ts',
  // The two new BAL-390 repositories: both are written to from paths that DO notify.
  'reviews.ts',
  'review-invite-tokens.ts',
  /**
   * BAL-428 adds the two booking repositories, for a REASON THIS FILE DID NOT PREVIOUSLY
   * COVER. `meetingsRepository`'s docblock hands its callers a post-commit obligation of
   * exactly the `close()` shape — enqueue an availability-cache rebuild for the
   * `expertProfileId` it returns — and spells out WHY the repository cannot do it itself:
   * the rebuild runs on a BullMQ queue that lives only in `apps/api`. That is the same
   * three-reason argument documented above (dependency direction, `apps/web` bundle
   * safety, and a pre-commit fire inside `db.transaction`), so the same mechanical guard
   * applies. `bullmq` / `BullMQ` are already in FORBIDDEN_MARKERS, which is what makes
   * this pin bite rather than merely document.
   *
   * `consultations.ts` is pinned alongside it because BAL-428 made it the availability
   * READ MODEL of the meeting lifecycle: it is READ-ONLY (its `create()` was deleted), and
   * its rows are written only by `_shared/consultation-projection.ts` inside a meeting
   * mutation's transaction. A publish smuggled in here would fire from inside that
   * transaction — the "your call is booked" email for a booking that then rolled back.
   */
  'meetings.ts',
  'consultations.ts',
];

/**
 * Anything that would make a repository a notifier. Module specifiers and call sites
 * both, because either one is the defect.
 */
const FORBIDDEN_MARKERS: readonly string[] = [
  '@balo/shared/notifications',
  'notifications/publisher',
  'publishNotificationEvent',
  'notificationEvents',
  'notificationsRepository',
  'userNotificationsRepository',
  'notificationLogRepository',
  'sendEmail',
  'brevo',
  'Brevo',
  'bullmq',
  'BullMQ',
];

/** Every module specifier imported by `source`. indexOf scan, never a regex (S5852). */
function importedModules(source: string): string[] {
  const specifiers: string[] = [];
  const marker = ' from ';
  let i = source.indexOf(marker);
  while (i !== -1) {
    const rest = source.slice(i + marker.length);
    const quote = rest.charAt(0);
    if (quote === "'" || quote === '"') {
      const close = rest.indexOf(quote, 1);
      if (close !== -1) specifiers.push(rest.slice(1, close));
    }
    i = source.indexOf(marker, i + marker.length);
  }
  return specifiers;
}

interface Scanned {
  readonly file: string;
  readonly source: string;
  readonly modules: string[];
}

const SCANNED: Scanned[] = PINNED_REPOSITORIES.map((file) => {
  const abs = fileURLToPath(new URL(`../repositories/${file}`, import.meta.url));
  const source = stripComments(readFileSync(abs, 'utf8'));
  return { file, source, modules: importedModules(source) };
});

describe('invariant: BAL-390 repositories never notify (D4 / §8.7.4)', () => {
  it('resolves every pinned repository and they are non-empty (guards a vacuous pass)', () => {
    expect(SCANNED).toHaveLength(PINNED_REPOSITORIES.length);
    for (const scanned of SCANNED) {
      expect(scanned.source.length).toBeGreaterThan(0);
      // Guard the guard: the import extractor must actually see the import every one of
      // these files has, or the module assertions below are all vacuous.
      expect(scanned.modules).toContain('../client');
    }
  });

  it('case-engagements.ts still declares close() — the method whose contract this encodes', () => {
    const caseRepo = SCANNED.find((scanned) => scanned.file === 'case-engagements.ts');
    expect(caseRepo?.source).toContain('async close(');
  });

  it.each(PINNED_REPOSITORIES)('%s imports nothing from the notifications tree', (file) => {
    const scanned = SCANNED.find((candidate) => candidate.file === file);
    const offenders = (scanned?.modules ?? []).filter(
      (module) => module.includes('notification') || module.includes('Notification')
    );
    expect(
      offenders,
      `${file} imports from the notifications tree (${offenders.join(', ')}). @balo/db ` +
        `cannot publish domain events — the publish belongs at the CALL SITE, post-commit.`
    ).toEqual([]);
  });

  it.each(PINNED_REPOSITORIES)('%s references no publisher, queue or email client', (file) => {
    const scanned = SCANNED.find((candidate) => candidate.file === file);
    const source = scanned?.source ?? '';
    const offenders = FORBIDDEN_MARKERS.filter((marker) => source.includes(marker));
    expect(
      offenders,
      `${file} references ${offenders.join(', ')}. Feature code publishes domain events; ` +
        `a repository does not. And a publish inside db.transaction() fires before commit.`
    ).toEqual([]);
  });

  it('every pinned repository imports ONLY the permitted dependency set', () => {
    // The naming-independent form: rather than enumerating what is forbidden, assert what
    // is allowed. A publisher smuggled in under any alias fails here.
    const violations: string[] = [];
    for (const scanned of SCANNED) {
      for (const module of scanned.modules) {
        // ⚠ `drizzle-orm` AND ITS SUBPATHS (BAL-422). `reviews.ts` imports `QueryBuilder`
        // from `drizzle-orm/pg-core` to compose the rating aggregate's shared subquery
        // fragment. Widening to the subpaths does NOT weaken this invariant: the whole
        // package is the ORM, it carries no publisher, queue or email client, and the two
        // assertions above still scan the source for notification markers under any alias.
        // Matching the prefix with the `/` boundary keeps a hypothetical
        // `drizzle-orm-notifier` package out.
        const permitted =
          module === 'drizzle-orm' ||
          module.startsWith('drizzle-orm/') ||
          module.startsWith('@balo/shared') ||
          module.startsWith('../') ||
          module.startsWith('./');
        if (!permitted) violations.push(`${scanned.file} → ${module}`);
      }
    }
    expect(
      violations,
      `A BAL-390 repository imports outside the permitted set (drizzle-orm and its ` +
        `subpaths, @balo/shared, relative modules within @balo/db):\n  ${violations.join('\n  ')}`
    ).toEqual([]);
  });
});
