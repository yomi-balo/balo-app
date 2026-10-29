import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * D6 — structural invariant: **a public review discloses only what its allow-list
 * permits.**
 *
 * THE RULE (stated once, on `PublicReviewEntry` in `@balo/shared/reviews`): a public review
 * names the reviewing person as "{First} {L}." (or "Verified client") with an optional
 * role. The client company appears only when the reviewer chose it AND the company is
 * allowed on reviews at read time. A note appears only when public. Never the full
 * surname, the email, a user id, an engagement or company id, or a private note.
 *
 * `reviews.reviewer_user_id` STAYS in the table (`NOT NULL`, `ON DELETE restrict`), so
 * ADR-1030 attribution and the audit trail are fully preserved; the public projection
 * reduces the person to what the rule above allows.
 *
 * TWO GUARDS, deliberately, in two registers:
 *   - `reviews.integration.test.ts` asserts the RUNTIME key sets of actual entries
 *     (`Object.keys(entry).sort()`) and that no id, surname, email or private note appears
 *     anywhere in the serialised result. That is the real proof — but it needs Docker, so
 *     it does not run on a laptop without it and it cannot speak about code that has not
 *     been called.
 *   - THIS file asserts the SOURCE: the allow-list projection routes the person through the
 *     one formatter, and the shared DTOs physically lack an identity field. It runs
 *     everywhere, in milliseconds, and it fails on the diff that widens the projection
 *     rather than on the query that uses it.
 *
 * ⚠ THE REAL RISK THIS CATCHES is someone "simplifying" the explicit `db.select({ … })`
 * into Drizzle's relational `with: { … }`, which hydrates FULL rows — the documented
 * secret-leak footgun (`reference_drizzle_with_hydration_leaks_secrets`). That rewrite
 * leaks the reviewer's email and every other column, and it typechecks. Hence the
 * `with:`/`select` assertions below.
 *
 * If this test fails: widening what a public review discloses is a decision for the
 * Decision Register, not a fix to this file.
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

/** The exact public shapes. Anything else on a public review is a decision, not a typo. */
const PUBLIC_REVIEW_ENTRY_KEYS: readonly string[] = [
  'companyHeader',
  'concludedOnIso',
  'engagementRating',
  'key',
  'kind',
  'products',
  'raters',
];

const PUBLIC_REVIEW_RATER_KEYS: readonly string[] = [
  'body',
  'descriptor',
  'initials',
  'name',
  'rating',
  'ratedAtIso',
  'reviewId',
];

/** Identifiers and private fields that must never be declared on either public shape. */
const FORBIDDEN_PUBLIC_FIELDS: readonly string[] = [
  'reviewerUserId',
  'reviewer_user_id',
  'engagementId',
  'companyId',
  'userId',
  'lastName',
  'surname',
  'email',
  'bodyVisibility',
];

const PUBLIC_INTERFACES: readonly string[] = ['PublicReviewEntry', 'PublicReviewRater'];

/**
 * The source of `listPublicEntriesByExpert`, from its declaration to the end of the file.
 * It is the LAST member of the repository object; the "exactly one member follows"
 * assertion below pins that, so if someone appends a method this fails loudly and they
 * re-anchor rather than discovering the slice silently widened.
 */
function publicProjectionSource(): string {
  const start = REVIEWS_REPOSITORY.indexOf('listPublicEntriesByExpert');
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

describe('invariant: a public review names only what its allow-list permits (D6)', () => {
  const projection = publicProjectionSource();

  it('resolves both sources and finds listPublicEntriesByExpert (guards a vacuous pass)', () => {
    expect(REVIEWS_REPOSITORY.length).toBeGreaterThan(0);
    expect(SHARED_REVIEWS.length).toBeGreaterThan(0);
    expect(projection.length).toBeGreaterThan(0);
    for (const name of PUBLIC_INTERFACES) {
      expect(interfaceKeys(SHARED_REVIEWS, name).length).toBeGreaterThan(0);
    }
  });

  it('listPublicEntriesByExpert is still the LAST repository member (the slice anchor)', () => {
    // The slice runs to end-of-file. If a member is appended after
    // `listPublicEntriesByExpert`, the slice silently widens and starts covering unrelated
    // code. Fail here instead: re-anchor the slice, do not delete the assertion.
    expect(countOf(projection, ': async (')).toBe(1);
  });

  it('the public projection selects an EXPLICIT allow-list, never a relational hydrate', () => {
    // `with: { … }` hydrates FULL rows and would leak the reviewer's email (and every other
    // column) while typechecking cleanly. This is the realistic regression, not a typo.
    // Matched without indentation so a Prettier reflow cannot silently break the guard.
    expect(projection).toContain('.select({');
    expect(projection).not.toContain('db.query.');
    expect(projection).not.toContain('with: {');
    expect(projection).not.toContain('users.email');
  });

  it('the person is attributed through the ONE formatter, with the company checked at read time', () => {
    expect(projection).toContain('formatReviewAttribution(');
    expect(projection).toContain('isCompanyNameAllowedOnReviews(');
    expect(projection).toContain('surnameInitial(');
  });

  it('the full surname is read only to reduce it to its initial', () => {
    // Every `.lastName` in the slice is either the projected column or the argument to
    // `surnameInitial`; any other use is a path for the full surname to leave the function.
    const projected = countOf(projection, 'users.lastName');
    const reduced = countOf(projection, 'surnameInitial(row.lastName)');
    expect(projected).toBe(1);
    expect(reduced).toBe(1);
    expect(countOf(projection, '.lastName')).toBe(projected + reduced);
  });

  it('the review body is projected ONLY through the public-visibility CASE', () => {
    // Remove the one CASE expression, then require that no `reviews.body` remains outside
    // it: `reviews.bodyVisibility` is the only `reviews.body…` reference allowed elsewhere.
    // A second, bare `reviews.body` select would carry a private note out of the database.
    const publicBodyCase =
      "CASE WHEN ${reviews.bodyVisibility} = 'public' THEN ${reviews.body} END";
    expect(countOf(projection, publicBodyCase)).toBe(1);
    const outsideCase = projection.replace(publicBodyCase, '');
    expect(countOf(outsideCase, 'reviews.body')).toBe(
      countOf(outsideCase, 'reviews.bodyVisibility')
    );
  });

  it('the stars come from the shared per-engagement fragment, through the engagement', () => {
    expect(projection).toContain('perEngagementAverages(');
    expect(projection).toContain('innerJoin(perEngagement');
    expect(projection).toContain('innerJoin(engagements');
    expect(projection).toContain('innerJoin(companies');
  });

  it('PublicReviewEntry declares EXACTLY the allowed key set', () => {
    // The type is what the repository is checked against, so this is the guard that makes
    // widening the projection a compile error rather than a review-time catch.
    const keys = interfaceKeys(SHARED_REVIEWS, 'PublicReviewEntry');
    expect([...keys].sort()).toEqual([...PUBLIC_REVIEW_ENTRY_KEYS].sort());
  });

  it('PublicReviewRater declares EXACTLY the allowed key set', () => {
    const keys = interfaceKeys(SHARED_REVIEWS, 'PublicReviewRater');
    expect([...keys].sort()).toEqual([...PUBLIC_REVIEW_RATER_KEYS].sort());
  });

  it.each(
    PUBLIC_INTERFACES.flatMap((name) => FORBIDDEN_PUBLIC_FIELDS.map((field) => [name, field]))
  )('%s declares no `%s` field', (name, field) => {
    expect(interfaceKeys(SHARED_REVIEWS, name)).not.toContain(field);
  });

  it('the superseded per-review shape is gone', () => {
    expect(SHARED_REVIEWS).not.toContain('interface PublicReview ');
    expect(REVIEWS_REPOSITORY).not.toContain('listPublicByExpert');
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
