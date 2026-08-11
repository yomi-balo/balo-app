import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';
import {
  caseEngagementFactory,
  expertDraftFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
} from '../../test/factories';
import { resolveMeetingContextOwner } from './meeting-context-owner';

/**
 * BAL-423 — the judgement-free "who owns this meeting context" READ, lifted from
 * `apps/api`'s `loadOwningParty` so both apps resolve tenancy from ONE definition.
 *
 * ⚠ WHAT THESE TESTS DO **NOT** ASSERT: anything about who may SEE the row. This function
 * reports the owning party and nothing else; the capability check lives in the caller
 * (ADR-1029). A non-`undefined` result is NOT an authorization.
 *
 * `admin` is unrepresentable here by TYPE — `PrimaryMeetingContext.contextType` is
 * `MeetingContextTypeWithHolder` and `selectPrimaryMeetingContext` drops admin rows — so
 * the six labels below are the whole domain.
 */

/** The four ENGAGEMENT-GRAIN labels. All four read `engagements`, hence one branch. */
const ENGAGEMENT_GRAIN_LABELS: MeetingContextTypeWithHolder[] = [
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
];

describe('resolveMeetingContextOwner — engagement grain', () => {
  it('resolves the owning company AND the delivering expert for ALL FOUR labels', async () => {
    const { engagement, companyId, expertProfileId } = await caseEngagementFactory();

    for (const contextType of ENGAGEMENT_GRAIN_LABELS) {
      await expect(
        resolveMeetingContextOwner({ contextType, contextId: engagement.id })
      ).resolves.toEqual({ companyId, expertProfileId });
    }
  });

  /**
   * `engagements.company_id` and `.expert_profile_id` are BOTH NOT NULL on the supertype
   * (BAL-417), so an engagement-grain context can never answer a null expert — unlike a
   * `match`-routed discovery call below.
   */
  it('never answers a null expert on the engagement grain — the supertype columns are NOT NULL', async () => {
    const { engagement } = await caseEngagementFactory();

    const owner = await resolveMeetingContextOwner({
      contextType: 'case',
      contextId: engagement.id,
    });

    expect(owner?.expertProfileId).toEqual(expect.any(String));
  });

  it('answers undefined for an unknown engagement id', async () => {
    await expect(
      resolveMeetingContextOwner({ contextType: 'case', contextId: randomUUID() })
    ).resolves.toBeUndefined();
  });

  /**
   * Every read this function makes already filters `deleted_at IS NULL`, so MISSING and
   * SOFT-DELETED collapse into ONE not-found outcome — which is what lets a gate answer a
   * single denial literal for both without extra work.
   */
  it('answers undefined for a SOFT-DELETED engagement — missing and deleted are one outcome', async () => {
    const { engagement } = await caseEngagementFactory({
      values: { deletedAt: new Date() },
      caseValues: { deletedAt: new Date() },
    });

    await expect(
      resolveMeetingContextOwner({ contextType: 'case', contextId: engagement.id })
    ).resolves.toBeUndefined();
  });
});

describe('resolveMeetingContextOwner — request grain (`project_discovery`)', () => {
  it('resolves company AND expert from the REQUEST row on a `direct`-routed request', async () => {
    const request = await projectRequestFactory();

    await expect(
      resolveMeetingContextOwner({ contextType: 'project_discovery', contextId: request.id })
    ).resolves.toEqual({
      companyId: request.companyId,
      expertProfileId: request.expertProfileId,
    });
  });

  /**
   * ⚠ THE `match`-ROUTED CASE, WHICH NAMES NOBODY. `project_requests_send_to_expert` makes
   * `send_to='match'` and a NULL `expert_profile_id` biconditional, so this is the ONLY
   * shape in the whole domain that resolves an owner with NO expert. The CLIENT side still
   * resolves (the request carries the company); an expert arm must SHORT-CIRCUIT on the null
   * rather than look a null profile id up.
   */
  it('resolves a `match`-routed request with expertProfileId === null — the company still owns it', async () => {
    const request = await projectRequestFactory({ sendTo: 'match', expertProfileId: null });

    const owner = await resolveMeetingContextOwner({
      contextType: 'project_discovery',
      contextId: request.id,
    });

    expect(owner).toEqual({ companyId: request.companyId, expertProfileId: null });
  });

  it('answers undefined for an unknown request id, and for a SOFT-DELETED request', async () => {
    const deleted = await projectRequestFactory({ deletedAt: new Date() });

    await expect(
      resolveMeetingContextOwner({ contextType: 'project_discovery', contextId: randomUUID() })
    ).resolves.toBeUndefined();
    await expect(
      resolveMeetingContextOwner({ contextType: 'project_discovery', contextId: deleted.id })
    ).resolves.toBeUndefined();
  });
});

describe('resolveMeetingContextOwner — relationship grain (`request_interaction`)', () => {
  /**
   * ⚠ TWO READS, AND THERE IS NO SHORTCUT. A `request_expert_relationships` row names an
   * EXPERT and a REQUEST, not a company — the company lives on the request. This test seeds
   * a relationship whose expert DIFFERS from the request's so the two halves cannot both be
   * satisfied by reading one row: the company MUST come from the request, the expert MUST
   * come from the relationship. Inferring tenancy from the expert instead would authorize by
   * DELIVERY IDENTITY on the membership axis — the axis confusion CLAUDE.md forbids.
   */
  it('takes the COMPANY from the request and the EXPERT from the relationship', async () => {
    const request = await projectRequestFactory();
    const otherExpert = await expertDraftFactory();
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: otherExpert.id,
    });
    expect(otherExpert.id).not.toBe(request.expertProfileId);

    await expect(
      resolveMeetingContextOwner({
        contextType: 'request_interaction',
        contextId: relationship.id,
      })
    ).resolves.toEqual({ companyId: request.companyId, expertProfileId: otherExpert.id });
  });

  it('answers undefined for an unknown relationship id', async () => {
    await expect(
      resolveMeetingContextOwner({ contextType: 'request_interaction', contextId: randomUUID() })
    ).resolves.toBeUndefined();
  });

  it('answers undefined for a SOFT-DELETED relationship, even though its request is live', async () => {
    const request = await projectRequestFactory();
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
      values: { deletedAt: new Date() },
    });

    await expect(
      resolveMeetingContextOwner({
        contextType: 'request_interaction',
        contextId: relationship.id,
      })
    ).resolves.toBeUndefined();
  });

  /**
   * ⚠ THE SECOND READ IS LOAD-BEARING AND IS SEPARATELY FAIL-CLOSED. A live relationship
   * hanging off a soft-deleted request must NOT resolve — otherwise a dead request's
   * tenancy would keep answering for it.
   */
  it('answers undefined when the relationship is LIVE but its request is SOFT-DELETED', async () => {
    const request = await projectRequestFactory({ deletedAt: new Date() });
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
    });

    await expect(
      resolveMeetingContextOwner({
        contextType: 'request_interaction',
        contextId: relationship.id,
      })
    ).resolves.toBeUndefined();
  });
});
