import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/helpers/strip-comments';

/**
 * BAL-390 D6 / §6.6 / §8.7.2 — structural invariant: **a published review is attributed
 * to the CLIENT COMPANY, never to the individual reviewer, and never anonymously.**
 *
 * THE CARVE-OUT THIS ENFORCES. CLAUDE.md's retrospective-attribution rule names the
 * PERSON with "@ company" on first mention ("Accepted by Dana @ Northwind Industrial").
 * D6 names the COMPANY. Both are right, because they govern different surfaces:
 *   - CLAUDE.md's rule governs PLATFORM-GENERATED statements of fact about who acted —
 *     audit trails, lifecycle notices, first-party records — narrated to parties already
 *     inside the engagement.
 *   - A published review is THIRD-PARTY OPINION rendered to strangers on a public
 *     profile. Naming the individual exports a named person's judgement of a named
 *     consultant to an audience they never chose, permanently, with no takedown path —
 *     which changes what people are willing to write and corrupts the aggregate.
 *
 * RESOLVED MECHANICALLY, NOT BY CONVENTION — which is the whole point of this file.
 * `reviews.reviewer_user_id` STAYS in the table (`NOT NULL`, `ON DELETE restrict`), so
 * ADR-1030 attribution is fully preserved and every first-party retrospective surface can
 * and should name the individual. Only the PUBLIC PROJECTION collapses to the company.
 *
 * TWO GUARDS, deliberately, in two registers:
 *   - `reviews.integration.test.ts` asserts the RUNTIME key set of an actual row
 *     (`Object.keys(row).sort()`) and that the reviewer's id appears nowhere in the
 *     serialised result. That is the real proof — but it needs Docker, so it does not run
 *     on a laptop without it and it cannot speak about code that has not been called.
 *   - THIS file asserts the SOURCE: the allow-list projection and the shared DTO both
 *     physically lack a reviewer field. It runs everywhere, in milliseconds, and it fails
 *     on the diff that widens the projection rather than on the query that uses it.
 *
 * ⚠ THE REAL RISK THIS CATCHES is not someone typing `reviewerUserId:` into the allow
 * list. It is someone "simplifying" the explicit `db.select({ … })` into Drizzle's
 * relational `with: { … }`, which hydrates FULL rows — the documented secret-leak footgun
 * (`reference_drizzle_with_hydration_leaks_secrets`). That rewrite leaks the reviewer AND
 * every other column, and it typechecks. Hence the `with:`/`select` assertions below.
 *
 * If this test fails: BAL-422 (or whoever mounts the public surface) must inherit the
 * carve-out, not widen the projection. Record the amendment in the Decision Register.
 */

const REVIEWS_REPOSITORY = stripComments(
  readFileSync(fileURLToPath(new URL('../repositories/reviews.ts', import.meta.url)), 'utf8')
);

const SHARED_REVIEWS = stripComments(
  readFileSync(
    fileURLToPath(new URL('../../../shared/src/reviews/index.ts', import.meta.url)),
    'utf8'
  )
);

/** The exact public shape. Anything else on a public review is a decision, not a typo. */
const PUBLIC_REVIEW_KEYS: readonly string[] = [
  'body',
  'clientCompanyName',
  'createdAtIso',
  'id',
  'rating',
];

/** Every spelling of "the individual who wrote this" that must not reach the public shape. */
const REVIEWER_IDENTITY_MARKERS: readonly string[] = [
  'reviewerUserId',
  'reviewer_user_id',
  'reviewerFirstName',
  'reviewerName',
  'reviewerEmail',
  'reviews.reviewerUserId',
];

/**
 * The source of `listPublicByExpert`, from its declaration to the end of the file. It is
 * the LAST member of the repository object; the "exactly one member follows" assertion
 * below pins that, so if someone appends a method this fails loudly and they re-anchor
 * rather than discovering the slice silently widened.
 */
function publicProjectionSource(): string {
  const start = REVIEWS_REPOSITORY.indexOf('listPublicByExpert');
  return start === -1 ? '' : REVIEWS_REPOSITORY.slice(start);
}

/** Count non-overlapping occurrences of `needle`. indexOf scan, never a regex (S5852). */
function countOf(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

/** Index of the `}` closing the `{` at `open`, or `-1`. Depth counter, never a regex. */
function matchingBraceIndex(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The `name` of each `name: Type` / `name?: Type` line in an interface body. */
function propertyNames(body: string): string[] {
  const keys: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).replace('?', '').trim();
    if (key.length > 0) keys.push(key);
  }
  return keys;
}

/**
 * The property names declared by `interface <name>` in `source`. Brace-counting scan; a
 * missing interface returns `[]`, which the non-vacuity test turns into a loud failure.
 */
function interfaceKeys(source: string, name: string): string[] {
  const decl = source.indexOf(`interface ${name}`);
  if (decl === -1) return [];
  const open = source.indexOf('{', decl);
  if (open === -1) return [];
  const close = matchingBraceIndex(source, open);
  if (close === -1) return [];
  return propertyNames(source.slice(open + 1, close));
}

describe('invariant: a published review names the company, never the person (BAL-390 D6)', () => {
  const projection = publicProjectionSource();

  it('resolves both sources and finds listPublicByExpert (guards a vacuous pass)', () => {
    expect(REVIEWS_REPOSITORY.length).toBeGreaterThan(0);
    expect(SHARED_REVIEWS.length).toBeGreaterThan(0);
    expect(projection.length).toBeGreaterThan(0);
    // Guard the guard: the reviewer marker MUST be findable elsewhere in this same file
    // by this same matcher (`upsert` and `findLive` both use it), or "not found in the
    // projection" would mean nothing at all.
    expect(REVIEWS_REPOSITORY).toContain('reviewerUserId');
  });

  it('listPublicByExpert is still the LAST repository member (the slice anchor)', () => {
    // The slice runs to end-of-file. If a member is appended after `listPublicByExpert`,
    // the slice silently widens and starts covering unrelated code. Fail here instead:
    // re-anchor the slice, do not delete the assertion.
    expect(countOf(projection, ': async (')).toBe(1);
  });

  it.each(REVIEWER_IDENTITY_MARKERS)('the public projection contains no `%s`', (marker) => {
    expect(
      projection.includes(marker),
      `listPublicByExpert references \`${marker}\`. A published review is a PARTY ` +
        `statement: the column stays in the table for attribution and audit, the ` +
        `rendering collapses to the client company. See BAL-390 §6.6.`
    ).toBe(false);
  });

  it('the public projection selects an EXPLICIT allow-list, never a relational hydrate', () => {
    // `with: { … }` hydrates FULL rows and would leak the reviewer id (and every other
    // column) while typechecking cleanly. This is the realistic regression, not a typo.
    // Matched without indentation so a Prettier reflow cannot silently break the guard.
    expect(projection).toContain('.select({');
    expect(projection).not.toContain('db.query.');
    expect(projection).not.toContain('with: {');
  });

  it('the public projection joins through the ENGAGEMENT to get the company name', () => {
    // Non-vacuity for the assertions above: prove the projection really does carry the
    // company attribution it is supposed to, not merely that it lacks the reviewer.
    expect(projection).toContain('clientCompanyName: companies.name');
    expect(projection).toContain('innerJoin(engagements');
    expect(projection).toContain('innerJoin(companies');
  });

  it('PublicReview declares EXACTLY the company-attributed key set', () => {
    // The type is what the repository is checked against, so this is the guard that makes
    // widening the projection a compile error rather than a review-time catch.
    const keys = interfaceKeys(SHARED_REVIEWS, 'PublicReview');
    expect(keys.length).toBeGreaterThan(0);
    expect([...keys].sort()).toEqual([...PUBLIC_REVIEW_KEYS].sort());
  });

  it.each(REVIEWER_IDENTITY_MARKERS)('PublicReview declares no `%s` field', (marker) => {
    expect(interfaceKeys(SHARED_REVIEWS, 'PublicReview')).not.toContain(marker);
  });

  it('reviews.reviewer_user_id still EXISTS on the table (D6 collapses the view, not the record)', () => {
    // The mirror-image failure: someone "fixes" the privacy concern by dropping the
    // column. That would destroy ADR-1030 attribution, break the partial unique that
    // makes a review one-per-person, and orphan the audit trail. The column stays.
    const schema = stripComments(
      readFileSync(fileURLToPath(new URL('../schema/reviews.ts', import.meta.url)), 'utf8')
    );
    expect(schema).toContain("'reviewer_user_id'");
    expect(schema).toContain('notNull()');
  });
});
