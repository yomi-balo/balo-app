import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * BAL-418 / ADR-1045 §2 structural invariant — THE load-bearing constraint of the
 * meetings primitive: **`meetings` carries NO context column.**
 *
 * "What is this meeting FOR" lives ENTIRELY in `meeting_contexts` (the polymorphic seam),
 * so adding a context type never widens the `meetings` table and never forks the read.
 * The ticket asks for this to be enforced BY TEST, NOT BY CONVENTION — a docblock does
 * not stop the next person from adding `engagement_id` "just for this one query".
 *
 * Follows the `createwithworkspace-no-domain-claim.test.ts` pattern: read the schema
 * source, strip comments with an indexOf SCANNER (never a regex — the SonarCloud S5852
 * ReDoS gate), and assert no forbidden column is DECLARED. Comments are stripped first so
 * this file's own prose — and `meetings.ts`'s docblock, which names every forbidden
 * column while explaining why it is absent — cannot trip or mask the check.
 */

/**
 * Every column name that would re-introduce a context onto `meetings`. Matched as a
 * quoted Drizzle column name (`uuid('engagement_id')`, `text("context_type")`, …), which
 * is how a column is DECLARED — so a mere mention in a string elsewhere cannot false-fire,
 * and an actual declaration cannot hide behind a different column helper.
 */
const FORBIDDEN_COLUMNS: readonly string[] = [
  'engagement_id',
  'context_id',
  'context_type',
  'credit_session_id',
  'project_request_id',
  'case_engagement',
  'case_engagement_id',
  'expert_profile_id',
  'company_id',
];

/** Every single-quoted literal in the (comment-stripped) source. Split, never a regex. */
function quotedLiterals(source: string): string[] {
  return source.split("'").filter((_, index) => index % 2 === 1);
}

/**
 * Every column name declared via `uuid('…')`, in source order. indexOf scan, never a regex
 * (the SonarCloud S5852 ReDoS gate). A `uuid(` with no parseable name yields `<unnamed>` so
 * a malformed declaration FAILS the assertion loudly rather than vanishing from the list.
 */
function uuidColumnNames(source: string): string[] {
  const names: string[] = [];
  const marker = 'uuid(';
  let i = source.indexOf(marker);
  while (i !== -1) {
    const open = source.indexOf("'", i + marker.length);
    const close = open === -1 ? -1 : source.indexOf("'", open + 1);
    names.push(open === -1 || close === -1 ? '<unnamed>' : source.slice(open + 1, close));
    i = source.indexOf(marker, i + marker.length);
  }
  return names;
}

describe('invariant: `meetings` carries no context column (BAL-418 / ADR-1045 §2)', () => {
  const schemaPath = fileURLToPath(new URL('../schema/meetings.ts', import.meta.url));
  const raw = readFileSync(schemaPath, 'utf8');
  const source = stripComments(raw);
  const literals = quotedLiterals(source);

  it('resolves schema/meetings.ts and it still declares the meetings table (non-vacuity guard)', () => {
    expect(raw.length).toBeGreaterThan(0);
    expect(source).toContain('pgTable(');
    expect(literals).toContain('meetings');
    // Guard the guard: a column the table DOES carry must be visible to the very matcher
    // the assertions below use, otherwise a matcher bug makes them all vacuous.
    expect(literals).toContain('scheduled_start');
  });

  it.each(FORBIDDEN_COLUMNS)('declares no `%s` column', (column) => {
    expect(literals).not.toContain(column);
    expect(source).not.toContain(`"${column}"`);
  });

  it('declares NO column name ending in `_id` at all (`id` itself is the PK, and is allowed)', () => {
    // Catch-all for a context column nobody thought to enumerate above (`package_id`,
    // `retainer_id`, `meeting_series_id`, …). If a legitimate non-context `*_id` column
    // is ever genuinely needed here, that is a decision to make deliberately — by editing
    // this test with a written justification, not by discovering it went green.
    expect(literals.filter((literal) => literal.endsWith('_id'))).toEqual([]);
  });

  it('declares EXACTLY ONE uuid column — the primary key (any other uuid IS a pointer)', () => {
    // ⚠ THE ASSERTION THAT ACTUALLY CLOSES THE RENAME ESCAPE. Every name-keyed check above
    // is defeated by picking a name that does not look like a context: `uuid('engagement')`
    // (no `_id` suffix) and `uuid('subject_ref')` both slip past all of them — verified by
    // mutation — while re-introducing exactly the coupling this invariant forbids. Even the
    // `.references(` check below misses them, because a dangling no-FK uuid is still a
    // pointer (the very shape BAL-418 was created to clean up on three other tables).
    //
    // This check is immune to naming because it keys on the TYPE. Everything `meetings`
    // legitimately holds is an enum (`status`, `outcome`), a timestamp, or text
    // (`daily_room_name`, `join_url`). The only uuid it needs is its own identity, so a
    // SECOND uuid column is — definitionally, whatever it is called — a reference to
    // another row, i.e. a context. Adding one is the thing that must fail.
    expect(uuidColumnNames(source)).toEqual(['id']);
  });

  it('declares NO foreign key at all (every context is resolved through meeting_contexts)', () => {
    // ⚠ THE NAMING-INDEPENDENT ASSERTION, and the one that actually holds the line.
    //
    // Every check above keys on the column NAME, so they are all defeated by choosing a
    // name that does not look like a context: `uuid('engagement')` (no `_id` suffix) and
    // `uuid('subject_ref')` both slip past them while re-introducing exactly the coupling
    // this invariant exists to prevent. This assertion cannot be dodged that way — it keys
    // on the RELATIONSHIP, not the label.
    //
    // `meetings` is the ROOT of this subgraph and legitimately declares ZERO foreign keys:
    // `meeting_contexts` and `meeting_presence` point AT it, never the reverse, and the
    // host is resolved through the context seam (BAL-413/ADR-1046), not a column here. So
    // "no `.references(` anywhere in this file" is exactly the invariant, stated in the one
    // form a rename cannot evade.
    expect(source).not.toContain('.references(');
  });
});
