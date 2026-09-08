import { describe, expect, it } from 'vitest';
import { PROPOSAL_CHANGE_SECTIONS } from '@balo/shared/project-requests';
import { proposalChangeSectionEnum } from '../schema/enums';

/**
 * BAL-427 (fix round) — structural invariant: `@balo/shared/project-requests`'
 * `PROPOSAL_CHANGE_SECTIONS` is EXACTLY the `proposal_change_section` pgEnum
 * (`packages/db/src/schema/enums.ts`), in the same order.
 *
 * WHY THIS TEST EXISTS. `PROPOSAL_CHANGE_SECTIONS` is a hand-maintained mirror of the pgEnum —
 * `@balo/shared` cannot import `@balo/db` (a client island value-importing `@balo/db` drags the
 * `postgres` driver into the browser bundle and breaks `next build`), so the tuple restates the
 * enum's values by hand rather than deriving them. Nothing before this test pinned the two
 * together. Before BAL-427 consolidated the five section values, the Server Action's own inline
 * spelling acted as an ACCIDENTAL pin — any drift between it and the DB column would have
 * surfaced as its own bug report. Consolidation removed that accident: now
 * `PROPOSAL_CHANGE_SECTIONS` drives BOTH the TS type and the API's Zod validator
 * (`apps/api/src/routes/notifications/schema.ts`), so widening the tuple widens the validator
 * right along with it. Without this test, adding a sixth value here would make the API accept a
 * `section` the `proposals.section` column rejects outright — a runtime insert failure instead
 * of a caught drift.
 *
 * A pgEnum value added, removed, reordered, or renamed without updating
 * `PROPOSAL_CHANGE_SECTIONS` to match fails HERE, instead of surfacing as a 500 on insert.
 *
 * Modelled on `declinable-statuses-match-the-transitions.test.ts`, the same shape for the
 * relationship-status tuple.
 */
describe('invariant: PROPOSAL_CHANGE_SECTIONS matches proposalChangeSectionEnum', () => {
  it('collects a non-empty enum (guards against a vacuous pass)', () => {
    expect(proposalChangeSectionEnum.enumValues.length).toBeGreaterThan(0);
  });

  it('has exactly the same values, in the same order, as the pgEnum', () => {
    expect([...PROPOSAL_CHANGE_SECTIONS]).toEqual([...proposalChangeSectionEnum.enumValues]);
  });

  it('has exactly the same values as the pgEnum regardless of order', () => {
    expect([...PROPOSAL_CHANGE_SECTIONS].sort()).toEqual(
      [...proposalChangeSectionEnum.enumValues].sort()
    );
  });
});
