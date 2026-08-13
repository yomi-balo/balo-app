import 'server-only';

import { cache } from 'react';
import {
  caseEngagementsRepository,
  companiesRepository,
  expertsRepository,
  transcriptsRepository,
  usersRepository,
} from '@balo/db';
import { durationMinutesOf } from '@/lib/meetings/meeting-duration';
import { meetingAllowsPostCallActions } from '@/lib/meetings/post-call-eligibility';
import { resolveRecapAccess, type RecapAccess } from '@/lib/meetings/resolve-recap-access';
import { readEngagementReview } from '@/lib/reviews/read-engagement-review';
import type {
  EndOfCallRatingView,
  EndOfCallResolveView,
  EndOfCallView,
  RecapContextType,
} from '@/lib/meetings/end-of-call-view-types';
import { formatRequesterLabel, resolveCounterparty } from '../../_lib/resolve-counterparty';
import { contextIsCase, resolveCaseHref } from '../../_lib/resolve-eyebrow';
import type { TranscriptStatusLike } from '../../_lib/resolve-recap-state';
import { contextIsRateable, resolveEndOfCallRecapReadiness } from './resolve-end-of-call-state';

/**
 * BAL-389 — the END-OF-CALL screen's SINGLE loader. It composes primitives that already ship
 * (the recap read gate, BAL-390's review reader, the counterparty hoist, the duration hoist)
 * into one lens-aware payload. It adds no repository, no query and no schema.
 *
 * ⚠ `cache()`-WRAPPED for symmetry with the recap's loader, so any future `generateMetadata`
 * shares one set of reads per render. The page currently exports STATIC metadata — see below.
 *
 * ⚠ EVERY READ GOES THROUGH A REPOSITORY. No raw query lives here.
 *
 * ⚠⚠ NOTHING MONEY-SHAPED IS READ, LET ALONE RENDERED. `creditSessionsRepository` is not
 * imported and is never called: this screen carries no charge, no rate, no credit balance and
 * no payout, so the figures cannot reach the payload in the first place. The receipt is the
 * recap's job (ADR-1044). A test asserts the absence rather than trusting the render.
 *
 * ⚠⚠ THE ROUTE IS NOT STATUS-GATED, BUT THE TWO CONSEQUENTIAL CONTROLS ARE — AND THE SPLIT IS
 * THE WHOLE DESIGN. DO NOT collapse it by copying `load-recap.ts`'s whole-loader guard. That
 * loader returns `null` for any status other than `ended`/`cancelled` because a recap of a
 * meeting that has not happened states four falsehoods at once (a green "Completed" chip over a
 * future date, "no consultation charge", "this call was not written up", and a resolve offer for
 * a consultation nobody had). THIS SCREEN STATES NONE OF THE FIRST THREE: it carries no money,
 * no artefact claims and no status chip, and its only status-dependent fact — the duration line —
 * is ALREADY omitted when the stamps are null. Copying that guard here would be actively harmful:
 * `meetings.status` has NO live transition writer (BAL-134 owns the lifecycle and is Backlog), so
 * every real row sits at `scheduled` and a terminal-status guard would 404 this screen in 100% of
 * sessions, including after BAL-435 lands the producer.
 *
 * ⚠⚠ WHAT **IS** GUARDED — THE RATING CAPTURE AND THE ONE-WAY CLOSE, VIA
 * `meetingAllowsPostCallActions` (`scheduled_start <= now AND status != 'cancelled'`). The fourth
 * falsehood above is NOT cosmetic and this screen did state it: a member who HAND-TYPES this URL
 * for a FUTURE or CANCELLED consultation was asked to rate an expert they had not met and offered
 * the IRREVERSIBLE `case_engagements.close()`. So `rating` and `resolve` both resolve to `null`
 * when the guard fails — **ABSENT, never disabled** — and neither underlying read is even issued.
 * The screen itself still renders, because "Meeting complete" over a throwaway, money-free,
 * non-durable shell is a cosmetic wrong, whereas an unreachable route is a dead feature.
 *
 * ⚠⚠ THIS RENDER GATE IS NOT THE ENFORCEMENT. A loader decides what is OFFERED; a Server Action
 * can be called directly. The close is enforced independently in `resolveCaseAction`, off the
 * SAME predicate and the SAME two meeting facts, so the RECAP inherits the identical rule. Read
 * `@/lib/meetings/post-call-eligibility` for the rule, the reason `started_at` cannot be the
 * signal, and the ACCEPTED no-show residual (BAL-134 tightens it).
 *
 * ⚠⚠ THE EXPERT PATH NEVER READS THE RATING OR THE CASE ROW. `readEngagementReview` and
 * `caseEngagementsRepository.findByEngagementId` sit behind `lens === 'client'` ternaries in the
 * `Promise.all` below, exactly as `load-recap.ts` gates `reviewsRepository.findLive`. The expert
 * lens does not merely fail to RENDER the rating — the data never enters the process. That is
 * layer 2 of the four-layer structural proof; layer 1 is the union in `end-of-call-view-types.ts`.
 */

/**
 * Load the whole end-of-call view, or `null`.
 *
 * ⚠ ONE `null` FOR EVERY DENIAL — missing, soft-deleted, unauthorised, declined, ambiguous, no
 * primary context and ADMIN-context. The caller answers ONE `notFound()` with one copy, so the
 * page never confirms a meeting exists to somebody who may not read it. Admin meetings resolve
 * on the PLATFORM axis (ADR-1035) and there is deliberately no admin branch anywhere here.
 */
export const loadEndOfCall = cache(
  async (
    meetingId: string,
    userId: string,
    now: Date = new Date()
  ): Promise<EndOfCallView | null> => {
    const access: RecapAccess | null = await resolveRecapAccess(meetingId, userId);
    if (access === null) {
      return null;
    }

    const { meeting, subject, companyId, expertProfileId, lens } = access;
    const contextType: RecapContextType = subject.contextType;
    const isCase = contextIsCase(contextType);
    const isClient = lens === 'client';

    /**
     * ⚠⚠ THE RENDER GATE FOR THE TWO CONSEQUENTIAL CONTROLS. `false` ⇒ no rating prompt and no
     * resolve prompt, and neither underlying read is issued — the same "the data never enters the
     * process" posture the expert lens gets. The route still renders; see the module docblock.
     */
    const postCallActionsAllowed = meetingAllowsPostCallActions(meeting, now);

    const [transcript, company, profile, reviewRead, caseRow] = await Promise.all([
      transcriptsRepository.findByMeetingId(meetingId),
      companiesRepository.findNameById(companyId),
      expertProfileId === null
        ? Promise.resolve(undefined)
        : expertsRepository.findDisplayProfileById(expertProfileId),
      // ⚠ CLIENT LENS ONLY, and only where a review can actually be WRITTEN. A request-grain
      // context's `contextId` is not an engagement id, and the two unbuilt engagement kinds
      // would always fail `applyReview` — see `RATEABLE_CONTEXTS`.
      isClient && postCallActionsAllowed && contextIsRateable(contextType)
        ? readEngagementReview(subject.contextId, userId)
        : Promise.resolve(undefined),
      // ⚠ CLIENT LENS ONLY. Only a case has something to resolve.
      isClient && postCallActionsAllowed && isCase
        ? caseEngagementsRepository.findByEngagementId(subject.contextId)
        : Promise.resolve(undefined),
    ]);

    const clientCompanyName = company?.name ?? 'the client';

    /**
     * ⚠⚠ THE REQUESTER NAME IS FETCHED **ALONGSIDE** THE COUNTERPARTY, NOT AFTER IT. It only
     * ever needed `case_engagements.resolution_requested_by_user_id`, which the batch above has
     * already returned — so awaiting it behind `resolveCounterparty` made it a FOURTH sequential
     * round trip (gate → batch → counterparty → requester) on a screen whose entire purpose is
     * to paint fast and be abandoned. It is a `Promise.all` sibling instead, and the label is
     * FORMATTED synchronously afterwards through the shared `formatRequesterLabel`, so the recap
     * and this screen still cannot drift on the attribution rule.
     *
     * ⚠ THE GATE IS `isClient && isCase` PLUS BOTH PAIRED COLUMNS. A non-case context has no
     * requester to name and the expert lens never reads the case row at all, so the query is not
     * merely unused there — it is never issued.
     */
    const requestedByUserId =
      isClient && isCase && caseRow?.resolutionRequestedAt != null
        ? (caseRow.resolutionRequestedByUserId ?? null)
        : null;

    const [labels, requesterRows] = await Promise.all([
      // ⚠ `null` ORDINAL, DELIBERATELY. The design reference carries NO "consultation N of M"
      // line on this screen — the ticket flagged it as worth CONSIDERING and the design pass did
      // not adopt it. The end screen reads only `expertShortName` / `agencyLabel`, never `party`.
      resolveCounterparty(lens, profile, clientCompanyName, null),
      requestedByUserId === null
        ? Promise.resolve([])
        : usersRepository.findNamesByIds([requestedByUserId]),
    ]);

    const base = {
      meetingId,
      contextType,
      isCase,
      counterpartyName: isClient ? labels.expertShortName : clientCompanyName,
      durationMinutes: durationMinutesOf(meeting),
      recapState: resolveEndOfCallRecapReadiness(
        (transcript?.status ?? null) as TranscriptStatusLike | null
      ),
      /**
       * ⚠ BAL-421's SHIPPED HELPER, NOT A HAND-BUILT `'/cases/' + id`. `resolveCaseHref` already
       * answers "does this context's id point at something `/cases/{id}` can resolve?" for the
       * recap, and that question has exactly one right answer per context type. A second copy of
       * the string concatenation is how the two surfaces start disagreeing about which contexts
       * have a case destination.
       *
       * ⚠ RESOLVED HERE, ON THE SERVER, AND PASSED AS DATA. The CTA is a client island; handing
       * it `contextId` + `isCase` to assemble a URL from would put route-shape knowledge in a
       * browser bundle and give the null case a second definition.
       */
      caseHref: resolveCaseHref(isCase, subject.contextId),
      /**
       * ⚠⚠ ON **BOTH** ARMS. The loader already used this to null the two consequential
       * controls; the shell needs the same fact to stop asserting "Consultation complete" over a
       * success tick — and promising a receipt — for a meeting that has not happened. `rating`
       * and `resolve` cannot stand in for it: they are also null on a non-rateable or non-case
       * context, and the expert arm has neither field.
       */
      meetingHeld: postCallActionsAllowed,
    };

    // ⚠⚠ THE EXPERT ARM IS CONSTRUCTED WITHOUT `rating` AND WITHOUT `resolve` — there is no
    // optional property for a bug to populate, and no flag for a conditional to get wrong.
    if (lens === 'expert') {
      return { ...base, lens: 'expert' };
    }

    // ⚠⚠ STATED AGAIN, AND NOT REDUNDANTLY. Both reads above were already skipped, so both
    // fields would be `null` by construction — but that is an IMPLICIT collapse through two
    // `undefined`s, and a later change that re-enables either read would silently re-open a
    // prompt to rate an unmet expert and an irreversible close. ONE predicate, asserted where
    // the payload is actually built. `postCallActionsAllowed` is a live signal on both sides,
    // so neither this branch nor the one below it is dead.
    if (!postCallActionsAllowed) {
      return { ...base, lens: 'client', rating: null, resolve: null };
    }

    const rating: EndOfCallRatingView | null =
      reviewRead === undefined
        ? null
        : {
            engagementId: subject.contextId,
            // ⚠ PASSED THROUGH UNTOUCHED. The `< 4` boundary belongs to
            // `resolveEndOfCallReviewState`, which `readEngagementReview` already called with
            // the DEFAULT `LOW_RATING_THRESHOLD`. Calling the resolver again here, or comparing
            // a rating to a literal anywhere in this feature, would be a second definition of a
            // rule BAL-390 built to have exactly one.
            state: reviewRead.state,
            existingBody: reviewRead.review?.body ?? null,
          };

    const [requesterRow] = requesterRows;

    return {
      ...base,
      lens: 'client',
      rating,
      resolve: resolveEndOfCallResolve(
        subject.contextId,
        caseRow,
        requestedByUserId === null
          ? null
          : formatRequesterLabel(requesterRow, labels.agencyLabel, labels.expertShortName),
        labels.expertShortName
      ),
    };
  }
);

/**
 * The resolve half of the client arm, or `null` when there is no case to close.
 *
 * ⚠ SYNCHRONOUS, AND THAT IS THE POINT OF THE CHANGE. The requester's name is already in hand
 * (fetched alongside the counterparty read above), so this function no longer issues a query and
 * no longer adds a round trip. `requesterLabel` arrives already FORMATTED by the shared
 * `formatRequesterLabel`, so the recap's R4 banner and this prompt still cannot drift on the
 * retrospective-attribution rule — the PERSON, with "@ agency" on first mention (CLAUDE.md).
 */
function resolveEndOfCallResolve(
  engagementId: string,
  caseRow: Awaited<ReturnType<typeof caseEngagementsRepository.findByEngagementId>>,
  requesterLabel: string | null,
  expertShortName: string
): EndOfCallResolveView | null {
  if (caseRow === undefined) {
    return null;
  }
  return {
    engagementId,
    requesterLabel,
    alreadyClosed: caseRow.closedAt != null,
    expertShortName,
  };
}
