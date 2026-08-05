import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { engagements, type Engagement } from '../schema';

/**
 * The SUPERTYPE engagement repository (BAL-417 / ADR-1045 §1).
 *
 * ⚠ "Engagement" in pre-BAL-417 code meant *Project*. It no longer does. Everything
 * project-shaped — the commercial terms, the origination provenance, the delivery
 * lifecycle, the portfolio/oversight/auto-accept reads — MOVED to
 * `project-engagements.ts`. This file holds only what is true of EVERY engagement
 * product.
 *
 * There is deliberately no type-agnostic list read here. The two that existed
 * (`listByCompany`, `listActiveWithProgress`) were zero-consumer, unfiltered surfaces
 * whose post-split shape would silently return Cases alongside Projects and report
 * meaningless milestone progress for them; both were deleted rather than migrated.
 * Any new list read must be type-scoped — root it on the concrete repository.
 *
 * NO TYPE RE-EXPORTS HERE. `EngagementType` is exported from its declaration site
 * (`_shared/engagement-supertype.ts`) and `EngagementStatus` from `./proposal-types`;
 * the package barrel sources both from there. A pass-through re-export on this module
 * would just be a second import path for the same symbol.
 */

export const engagementsRepository = {
  /**
   * Live engagement by id — the TYPE-AGNOSTIC point read. Returns the small supertype
   * row (parties, type, coarse status, currency, fee, activation, timestamps); it
   * carries NO commercial terms and NO delivery lifecycle. Callers that need those
   * must go through `projectEngagementsRepository` / `caseEngagementsRepository`.
   */
  async findById(id: string): Promise<Engagement | undefined> {
    return db.query.engagements.findFirst({
      where: and(eq(engagements.id, id), isNull(engagements.deletedAt)),
    });
  },
};
