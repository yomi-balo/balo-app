import { describe, expect, it } from 'vitest';
import { PROPOSAL_CLAUSE_KINDS } from '@balo/shared/project-requests';
import { proposalClauseKindEnum } from '../schema/enums';

/**
 * Structural invariant: `PROPOSAL_CLAUSE_KINDS` in `@balo/shared/project-requests` is EXACTLY
 * the `proposal_clause_kind` pgEnum (`packages/db/src/schema/enums.ts`), in the same order.
 *
 * The tuple restates the enum by hand because `@balo/shared` cannot import `@balo/db`: the
 * composer is a client island, and value-importing `@balo/db` there drags the `postgres` driver
 * into the browser bundle. The order matters as well as the set, because it is the reading
 * order of the three lists everywhere they render, and the repositories sort by the enum.
 *
 * A pgEnum value added, removed, reordered or renamed without updating the tuple fails HERE,
 * instead of as a rejected insert or a list rendered in the wrong place.
 *
 * Modelled on `proposal-change-sections-match-the-pgenum.test.ts`.
 */
describe('invariant: PROPOSAL_CLAUSE_KINDS matches proposalClauseKindEnum', () => {
  it('collects a non-empty enum (guards against a vacuous pass)', () => {
    expect(proposalClauseKindEnum.enumValues.length).toBeGreaterThan(0);
  });

  it('has exactly the same values, in the same order, as the pgEnum', () => {
    expect([...PROPOSAL_CLAUSE_KINDS]).toEqual([...proposalClauseKindEnum.enumValues]);
  });

  it('has exactly the same values as the pgEnum regardless of order', () => {
    expect([...PROPOSAL_CLAUSE_KINDS].sort()).toEqual(
      [...proposalClauseKindEnum.enumValues].sort()
    );
  });
});
