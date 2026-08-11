import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
// Comments are stripped before the purity scan below, so the docblocks that EXPLAIN these
// absences do not trip it. ONE shared indexOf-scan implementation (no regex ⇒ no ReDoS
// surface, and no second copy to drift) — see `@balo/shared/testing`'s own docblock.
import { stripComments } from '../testing/strip-comments';
import {
  resolveContextOwner,
  type MeetingContextOwnerReads,
  type PrimaryMeetingContext,
} from './index';

/**
 * BAL-423 — the ONE definition of "who owns this meeting context", now that the switch has
 * been hoisted out of `apps/api`'s `loadOwningParty` and `@balo/db`'s
 * `resolveMeetingContextOwner`. Both callers delegate here, so these are the tests that pin
 * the RULE; each caller's own tests pin only its binding and its logging.
 *
 * ⚠ WHAT THESE TESTS DO **NOT** ASSERT: anything about who may SEE the row. This function
 * reports the owning party and nothing else; the capability check lives in the caller
 * (ADR-1029). A `resolved` outcome is NOT an authorization.
 *
 * ⚠ NOR DO THEY ASSERT SOFT-DELETE FILTERING — they cannot, and that is the point. Filtering
 * `deleted_at IS NULL` is the INJECTED READ's obligation; a missing row and a soft-deleted
 * one both arrive here as `undefined`. `@balo/db`'s integration test is where that
 * obligation is actually exercised against Postgres.
 */

const ENGAGEMENT_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
const RELATIONSHIP_ID = '77777777-7777-4777-8777-777777777777';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_EXPERT_PROFILE_ID = '99999999-9999-4999-8999-999999999999';

/** The four ENGAGEMENT-GRAIN labels. All four read `engagements`, hence one branch. */
const ENGAGEMENT_GRAIN_LABELS = [
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
] as const;

/**
 * ⚠ RETURNS THE `reads` OBJECT ITSELF, and every assertion below reaches through it
 * (`reads.findEngagement`), rather than handing back separately-destructured spies. An
 * earlier draft returned the DEFAULT spies alongside the object, so a test that passed an
 * override asserted against the spy the rule never called — and passed vacuously in the
 * `not_called` direction. One object, one identity.
 */
function makeReads(overrides: Partial<MeetingContextOwnerReads> = {}): MeetingContextOwnerReads {
  return {
    findEngagement: vi.fn().mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    }),
    findProjectRequest: vi.fn().mockResolvedValue({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    }),
    findRelationship: vi.fn().mockResolvedValue({
      projectRequestId: REQUEST_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    }),
    ...overrides,
  };
}

describe('resolveContextOwner — engagement grain', () => {
  it('resolves the owning company AND the delivering expert for ALL FOUR labels', async () => {
    for (const contextType of ENGAGEMENT_GRAIN_LABELS) {
      const reads = makeReads();

      await expect(
        resolveContextOwner({ contextType, contextId: ENGAGEMENT_ID }, reads)
      ).resolves.toEqual({
        outcome: 'resolved',
        owner: { companyId: COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID },
      });
    }
  });

  it('reads `engagements` ONLY — neither request read is touched', async () => {
    const reads = makeReads();

    await resolveContextOwner({ contextType: 'case', contextId: ENGAGEMENT_ID }, reads);

    expect(reads.findEngagement).toHaveBeenCalledExactlyOnceWith(ENGAGEMENT_ID);
    expect(reads.findProjectRequest).not.toHaveBeenCalled();
    expect(reads.findRelationship).not.toHaveBeenCalled();
  });

  it('answers not_found when the engagement read comes back empty', async () => {
    const reads = makeReads({ findEngagement: vi.fn().mockResolvedValue(undefined) });

    await expect(
      resolveContextOwner({ contextType: 'case', contextId: ENGAGEMENT_ID }, reads)
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});

describe('resolveContextOwner — request grain (`project_discovery`)', () => {
  it('resolves the company and expert from the request itself, in ONE read', async () => {
    const reads = makeReads();

    await expect(
      resolveContextOwner({ contextType: 'project_discovery', contextId: REQUEST_ID }, reads)
    ).resolves.toEqual({
      outcome: 'resolved',
      owner: { companyId: COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID },
    });
    expect(reads.findProjectRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID);
    expect(reads.findEngagement).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE `match`-ROUTED CASE. A discovery call routed to the marketplace names NOBODY on the
   * expert side, and the rule must pass that `null` through rather than treat it as a
   * failure — the company still owns the context, which is what a client-side gate needs.
   */
  it('passes a null expert through for a `match`-routed request — it is not a not_found', async () => {
    const reads = makeReads({
      findProjectRequest: vi.fn().mockResolvedValue({
        companyId: COMPANY_ID,
        expertProfileId: null,
      }),
    });

    await expect(
      resolveContextOwner({ contextType: 'project_discovery', contextId: REQUEST_ID }, reads)
    ).resolves.toEqual({
      outcome: 'resolved',
      owner: { companyId: COMPANY_ID, expertProfileId: null },
    });
  });

  it('answers not_found when the request read comes back empty', async () => {
    const reads = makeReads({ findProjectRequest: vi.fn().mockResolvedValue(undefined) });

    await expect(
      resolveContextOwner({ contextType: 'project_discovery', contextId: REQUEST_ID }, reads)
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});

describe('resolveContextOwner — relationship grain (`request_interaction`)', () => {
  /**
   * ⚠ THE LOAD-BEARING ASSERTION OF THIS WHOLE MODULE. The COMPANY comes from the REQUEST and
   * the EXPERT from the RELATIONSHIP. Taking tenancy from the relationship's expert instead
   * would authorize by DELIVERY IDENTITY on the membership axis — the axis confusion
   * CLAUDE.md forbids — so the two fields are deliberately sourced from different rows here.
   */
  it('takes the COMPANY from the request and the EXPERT from the relationship', async () => {
    const reads = makeReads({
      findRelationship: vi.fn().mockResolvedValue({
        projectRequestId: REQUEST_ID,
        expertProfileId: OTHER_EXPERT_PROFILE_ID,
      }),
    });

    await expect(
      resolveContextOwner({ contextType: 'request_interaction', contextId: RELATIONSHIP_ID }, reads)
    ).resolves.toEqual({
      outcome: 'resolved',
      // The expert is the RELATIONSHIP's, not the request's `EXPERT_PROFILE_ID`.
      owner: { companyId: COMPANY_ID, expertProfileId: OTHER_EXPERT_PROFILE_ID },
    });
    expect(reads.findRelationship).toHaveBeenCalledExactlyOnceWith(RELATIONSHIP_ID);
    // TWO reads, and the second is keyed by the relationship's request pointer.
    expect(reads.findProjectRequest).toHaveBeenCalledExactlyOnceWith(REQUEST_ID);
  });

  it('answers not_found on a missing relationship WITHOUT attempting the second read', async () => {
    const reads = makeReads({
      findRelationship: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      resolveContextOwner({ contextType: 'request_interaction', contextId: RELATIONSHIP_ID }, reads)
    ).resolves.toEqual({ outcome: 'not_found' });
    expect(reads.findProjectRequest).not.toHaveBeenCalled();
  });

  it('answers not_found when the SECOND hop comes back empty', async () => {
    const reads = makeReads({ findProjectRequest: vi.fn().mockResolvedValue(undefined) });

    await expect(
      resolveContextOwner({ contextType: 'request_interaction', contextId: RELATIONSHIP_ID }, reads)
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});

describe('resolveContextOwner — the unhandled arm', () => {
  /**
   * ⚠ UNREACHABLE BY TYPE, AND REACHED HERE ON PURPOSE. `PrimaryMeetingContext.contextType`
   * is `MeetingContextTypeWithHolder`, so no well-typed caller can supply a seventh label —
   * only a cast can. The arm exists so a label added to the DATABASE fails closed here and
   * fails LOUDLY at `apps/api`'s `const exhaustive: never` witness, and this is the only
   * place it can be exercised at all.
   */
  it('fails closed with the offending label rather than throwing', async () => {
    const reads = makeReads();
    const seventhLabel = { contextType: 'quarterly_review', contextId: ENGAGEMENT_ID };

    await expect(
      resolveContextOwner(seventhLabel as unknown as PrimaryMeetingContext, reads)
    ).resolves.toEqual({ outcome: 'unhandled', contextType: 'quarterly_review' });

    // Fails closed BEFORE any read — an unknown label must never become a subject we query.
    expect(reads.findEngagement).not.toHaveBeenCalled();
    expect(reads.findProjectRequest).not.toHaveBeenCalled();
    expect(reads.findRelationship).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THIS ASSERTS ON THE MODULE **SOURCE**, BECAUSE THERE IS NOTHING ELSE TO ASSERT ON. A
   * pure module has no logger to spy on, so a behavioural test cannot express "it does not
   * log" — the previous version of this test called the function and asserted
   * `toHaveProperty('contextType')`, which says nothing whatsoever about logging and was
   * strictly weaker than the test fourteen lines above it. It could not have failed under any
   * change that added a logger.
   *
   * The property that actually matters is STRUCTURAL: `unhandled` is HANDED OUT so `apps/api`
   * can `log.warn` it, which only holds while this module itself is silent
   * (`repositories-never-notify.test.ts`'s spirit, one layer up).
   */
  it('contains no logging call site at all — the caller owns that, so the rule stays pure', () => {
    // `import.meta.url`-relative, not `process.cwd()`-relative: CI runs vitest from the repo
    // root, and a cwd-relative read ENOENTs there (`reference_web_server_disk_asset_cwd`).
    const code = stripComments(
      readFileSync(new URL('./context-owner.ts', import.meta.url), 'utf8')
    );

    // Guards against a vacuous pass — if the read or the strip broke, everything below would
    // pass for free.
    expect(code).toContain('export async function resolveContextOwner');

    for (const token of ['console.', 'createLogger', 'log.info', 'log.warn', 'log.error']) {
      expect(code).not.toContain(token);
    }
  });
});

describe('resolveContextOwner — purity', () => {
  /**
   * ⚠ THE MECHANICAL PROOF THAT THIS MODULE STAYS PURE, in the form
   * `authorize-conversation-context.test.ts` established.
   *
   *   · `@balo/db` — importing it would INVERT the dependency graph (`@balo/db` depends on
   *     `@balo/shared`) and drag `postgres` into every consumer bundle
   *     (`reference_balo_db_client_bundle_footgun`). The injected reads exist to avoid it.
   *   · `server-only` — a `@balo/shared` `server-only` subpath typechecks, builds green and
   *     then CRASH-LOOPS Railway, because `apps/api`'s tsup bundles `platform=node` without
   *     the `react-server` condition (the PR #191 hazard).
   */
  it('imports neither `@balo/db` nor `server-only`', () => {
    // `import.meta.url`-relative, not `process.cwd()`-relative: CI runs vitest from the repo
    // root, and a cwd-relative read ENOENTs there (`reference_web_server_disk_asset_cwd`).
    const source = readFileSync(new URL('./context-owner.ts', import.meta.url), 'utf8');
    const code = stripComments(source);

    expect(code).not.toContain('@balo/db');
    expect(code).not.toContain('server-only');
  });

  /**
   * `packages/shared` compiles as RAW TypeScript for `apps/web`'s Turbopack graph, where a
   * `.js` specifier on a relative import 404s at runtime — the OPPOSITE rule to `apps/api`.
   * See `reference_balo_shared_no_js_extensions_in_reexports`.
   */
  it('uses no `.js` extension on its relative imports', () => {
    const code = stripComments(
      readFileSync(new URL('./context-owner.ts', import.meta.url), 'utf8')
    );

    expect(code).not.toMatch(/from\s+'\.\.?\/[^']*\.js'/);
  });
});
