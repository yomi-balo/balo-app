import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * BAL-408 / D4 structural invariant — **`meeting_guests` carries NO `expert_profile_id`,
 * and must never gain one.**
 *
 * WHY THIS IS AN INVARIANT AND NOT A COMMENT. Multi-expert delivery is DEFERRED (ADR-1045
 * §5's future `engagement_experts`), not merely unbuilt — so a participant row that points
 * at an expert profile would pre-empt a decision nobody has made. Concretely, an
 * expert-side guest must not become an undeclared CO-DELIVERER: the moment this table
 * carries `expert_profile_id`, the next reader of "who delivered this engagement" has two
 * plausible sources instead of one, and the wrong one is the one an attacker (or a
 * well-meaning refactor) can write to. Delivery identity is resolved ONLY through
 * `engagements.expert_profile_id` / `project_requests.expert_profile_id`, which is what
 * makes `hasEngagementCapability` (ADR-1046 / BAL-413) unreachable from a guest row — it
 * reads no participant table at all. Payout and settlement resolve the expert the same way.
 *
 * Follows `meetings-no-context-column.test.ts` exactly: read the schema source, strip
 * comments with an indexOf SCANNER (never a regex — the SonarCloud S5852 ReDoS gate), and
 * assert no forbidden column is DECLARED. Comments are stripped FIRST so this file's own
 * prose — and `guests.ts`'s docblock, which names `expert_profile_id` several times while
 * explaining why it is absent — can neither trip nor mask the check.
 */

/**
 * Every column name that would make a guest row a delivery-identity pointer. Matched as a
 * quoted Drizzle column name, which is how a column is DECLARED.
 */
const FORBIDDEN_COLUMNS: readonly string[] = [
  'expert_profile_id',
  'expert_id',
  'agency_id',
  'engagement_id',
  'credit_session_id',
  'project_request_id',
  'company_id',
];

/**
 * The EXACT set of uuid columns `meeting_guests` legitimately declares, in source order.
 *
 * ⚠ THIS IS THE ASSERTION THAT ACTUALLY HOLDS THE LINE, because it is immune to naming.
 * Every name-keyed check is defeated by choosing a label that does not look like what it
 * is — `uuid('deliverer')` or `uuid('profile_ref')` slip past all of them while
 * re-introducing exactly the coupling this invariant forbids. A uuid column IS a pointer
 * to another row, whatever it is called, so pinning the set means a NEW one must be added
 * here deliberately, with a written justification, rather than discovered green.
 */
const ALLOWED_UUID_COLUMNS: readonly string[] = [
  'id',
  'meeting_id',
  'user_id',
  'invited_by_id',
  'revoked_by_user_id',
  'admitted_by_user_id',
  'converted_to_user_id',
];

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

describe('invariant: `meeting_guests` carries no expert-profile column (BAL-408 / D4)', () => {
  const schemaPath = fileURLToPath(new URL('../schema/guests.ts', import.meta.url));
  const raw = readFileSync(schemaPath, 'utf8');
  const source = stripComments(raw);

  it('resolves schema/guests.ts and it still declares the meeting_guests table (non-vacuity guard)', () => {
    expect(raw.length).toBeGreaterThan(0);
    expect(source).toContain('pgTable(');
    expect(source).toContain("'meeting_guests'");
    // Guard the guard: a column the table DOES carry must be visible to the very matcher
    // the assertions below use, otherwise a matcher bug makes them all vacuous.
    expect(uuidColumnNames(source)).toContain('meeting_id');
    // And the comment stripper must really have run — `expert_profile_id` appears MANY
    // times in the docblock, so if stripping silently no-opped, the checks below would
    // fail for the wrong reason and this assertion says which.
    expect(raw).toContain('expert_profile_id');
  });

  it.each(FORBIDDEN_COLUMNS)('declares no `%s` column', (column) => {
    expect(source).not.toContain(`'${column}'`);
    expect(source).not.toContain(`"${column}"`);
  });

  it('declares EXACTLY the allowed uuid columns — any other uuid IS a pointer', () => {
    expect(uuidColumnNames(source)).toEqual([...ALLOWED_UUID_COLUMNS]);
  });

  it('imports no expert/agency/engagement schema module (the naming-independent check)', () => {
    // ⚠ The rename escape the name checks above cannot close: a column called anything at
    // all still needs a `.references(() => expertProfiles.id)` to be a real FK, and that
    // needs an import. Every table `meeting_guests` may legitimately point at is `meetings`
    // or `users`.
    expect(source).not.toContain('./experts');
    expect(source).not.toContain('./agencies');
    expect(source).not.toContain('./engagements');
    expect(source).not.toContain('expertProfiles');
    expect(source).not.toContain('engagements');
  });
});
