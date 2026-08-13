import 'server-only';

import { cache } from 'react';
import {
  actionItemsRepository,
  agenciesRepository,
  caseEngagementsRepository,
  companiesRepository,
  creditSessionsRepository,
  expertsRepository,
  meetingContextsRepository,
  meetingFilesRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  reviewsRepository,
  transcriptArtifactsRepository,
  transcriptsRepository,
  usersRepository,
  type CaseEngagementRow,
  type Meeting,
} from '@balo/db';
import {
  expertPartyDisplayName,
  personDisplayName,
  personWithOrgLabel,
} from '@balo/shared/parties';
import type { RecapContextType } from '@balo/analytics/events';
import { formatLongUtc } from '@/lib/format/utc-date';
import { log } from '@/lib/logging';
import { fetchSessionMoneyBlock } from '@/lib/api/session-money-block';
import { resolveRecapAccess, type RecapAccess } from '@/lib/meetings/resolve-recap-access';
import type {
  RecapHeaderView,
  RecapPartyView,
  RecapResolveView,
  RecapStatusView,
  RecapView,
} from '@/lib/meetings/recap-view-types';
import {
  deriveConsultationOrdinal,
  formatOrdinalLine,
} from '@/lib/meetings/derive-consultation-ordinal';
import { contextIsCase, resolveEyebrow } from './resolve-eyebrow';
import {
  resolveArtifacts,
  resolveMoneyView,
  resolveNotHeld,
  resolveRecapState,
  type TranscriptStatusLike,
} from './resolve-recap-state';
import { countOpenActionItems, mapRecapActionItems } from './map-recap-action-items';
import { mapRecapFiles } from './map-recap-files';

/**
 * BAL-388 — the recap's SINGLE loader. Assembles five already-shipped primitives (meeting +
 * context seam, transcript artefacts, action items, meeting files, credit-session money block)
 * into ONE lens-aware payload.
 *
 * ⚠ `cache()`-WRAPPED so `generateMetadata` and the page body share ONE set of reads per
 * render (React dedupes within a single server request) — the precedent is
 * `engagements/[id]/page.tsx`. `generateMetadata` re-runs the FULL gate through this loader
 * before specialising the title, because Next streams the document title even when the body
 * `notFound()`s.
 *
 * ⚠ EVERY READ GOES THROUGH A REPOSITORY. No raw query lives here.
 *
 * ⚠⚠ EVERY COUNTERPARTY READ IS COLUMN-PROJECTED AT THE REPOSITORY, NOT NARROWED HERE.
 * `usersRepository.findDisplayById` (id/first/last/avatar), `expertsRepository
 * .findDisplayProfileById` (six display columns) and `companiesRepository.findNameById`
 * (id/name) exist precisely so this loader CANNOT hold `users.email`, `users.workosId` or
 * `expert_profiles.rate_cents` in the first place. That last one matters most: `rate_cents` is
 * the UN-MARKED-UP consultant rate, and the client lens already carries the all-in charge, so
 * a payload holding both would hand the client the Balo margin. A bare relational hydrate plus
 * a field-by-field projection downstream would LOOK identical and be one careless spread away
 * from leaking, because TypeScript excess-property checking does NOT apply to spreads (memory
 * `reference_drizzle_with_hydration_leaks_secrets`). Uploader names come from
 * `findNamesByIds`, the same posture. THE MONEY ROW IS THE SAME RULE:
 * `creditSessionsRepository.findIdByMeetingId` projects to `id` alone, so `balo_fee_bps` (the
 * literal margin), `expert_rate_minor_per_minute`, `expert_accrued_minor` and
 * `stripe_payment_intent_id` are structurally absent here — the figures the client is allowed
 * to see arrive already fee-concealed from the api money block. Concealment is enforced by what
 * the ROWS can hold, not by remembering to omit things downstream.
 *
 * ⚠ NO MEETING ROW CROSSES TO THE CLIENT. `listMeetingsForContext` returns full `Meeting`
 * rows including `dailyRoomName` and `joinUrl`; they are narrowed to five fields and reduced
 * to two NUMBERS by `deriveConsultationOrdinal` before anything is composed.
 */

/**
 * How long after a meeting ends a transcript may still legitimately be missing. Inside this
 * window the artefact sections render PROCESSING; outside it they render ABSENT.
 *
 * ⚠ A CONSTANT, NOT CONFIG. `platform_config` is not on `main` (its PR is unmerged), so a
 * typed constant is what configurable means today.
 */
const PIPELINE_GRACE_MS = 30 * 60 * 1000;

/** Engagement-grain contexts — the ones whose `contextId` IS an `engagements.id`. */
const ENGAGEMENT_GRAIN: ReadonlySet<RecapContextType> = new Set([
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
]);

/** Humane fallback titles for contexts whose own title has no cheap single read. */
const FALLBACK_TITLE: Record<RecapContextType, string> = {
  case: 'Consultation',
  project_discovery: 'Discovery call',
  project_kickoff: 'Project kickoff',
  package_session: 'Package session',
  retainer_checkin: 'Retainer check-in',
  request_interaction: 'Intro call',
};

/** Whole minutes between the two stamps; `null` when either is missing (never a bare zero). */
function durationMinutesOf(meeting: Meeting): number | null {
  const { startedAt, endedAt } = meeting;
  if (startedAt === null || endedAt === null) return null;
  return Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000));
}

/** Up to two initials for the avatar fallback. NEVER derived from an email address. */
function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const [first, second] = parts;
  if (first === undefined) return '?';
  const tail = second === undefined ? '' : second.charAt(0);
  return (first.charAt(0) + tail).toUpperCase();
}

/**
 * §R1 status chip. ⚠ CASE STATE WINS OVER MEETING STATE — a resolved case's recap should read
 * as resolved, not as completed. The chip NEVER names who was absent; that is R11's body
 * copy's job, once.
 *
 * ⚠⚠ ONLY A TERMINAL MEETING REACHES THIS. `loadRecap` returns `null` (→ one `notFound()`)
 * for `scheduled` / `waiting_for_participants` / `in_progress`, so there is deliberately NO
 * pre-`ended` arm here: a recap of a meeting that has not happened yet is not a recap. See
 * the guard in `loadRecap`, which is where the decision lives and where its test pins it.
 */
function resolveStatus(
  meeting: Meeting,
  caseRow: CaseEngagementRow | undefined,
  artifactsProcessing: boolean
): RecapStatusView {
  if (caseRow?.closedAt != null) {
    return caseRow.closeReason === 'auto_inactive'
      ? { label: 'Closed — inactive', tone: 'neutral', icon: 'ban' }
      : { label: 'Resolved', tone: 'success', icon: 'circle-check' };
  }
  if (meeting.status === 'cancelled') {
    return { label: 'Cancelled', tone: 'neutral', icon: 'ban' };
  }
  if (meeting.outcome === 'no_show_client' || meeting.outcome === 'missed_call') {
    return { label: 'Not held', tone: 'neutral', icon: 'ban' };
  }
  if (artifactsProcessing) {
    return { label: 'Wrapping up', tone: 'warning', icon: 'clock' };
  }
  return { label: 'Completed', tone: 'success', icon: 'check' };
}

/** §R1 closed-case note. `null` while the case is open, or on a non-case context. */
function resolveClosedNote(caseRow: CaseEngagementRow | undefined): string | null {
  const closedAt = caseRow?.closedAt;
  if (closedAt == null) return null;
  if (caseRow?.closeReason === 'auto_inactive') {
    return 'Closed automatically after 30 days without activity. Everything stays available.';
  }
  return 'Resolved on ' + formatLongUtc(closedAt) + '. Everything here stays available.';
}

/** The subject title, per the §R1 context table. */
async function resolveTitle(
  contextType: RecapContextType,
  contextId: string,
  caseRow: CaseEngagementRow | undefined
): Promise<string> {
  if (contextType === 'case') {
    return caseRow?.title ?? FALLBACK_TITLE.case;
  }
  if (contextType === 'project_discovery') {
    const request = await projectRequestsRepository.findById(contextId);
    return request?.title ?? FALLBACK_TITLE.project_discovery;
  }
  if (contextType === 'request_interaction') {
    const relationship = await requestExpertRelationshipsRepository.findById(contextId);
    if (relationship === undefined) return FALLBACK_TITLE.request_interaction;
    const request = await projectRequestsRepository.findById(relationship.projectRequestId);
    return request?.title ?? FALLBACK_TITLE.request_interaction;
  }
  // The three remaining ENGAGEMENT-grain contexts derive their title from a project graph this
  // page never otherwise loads. A humane label is stated instead of a second hydrate; none of
  // those context types has a live producer today.
  return FALLBACK_TITLE[contextType];
}

/**
 * The PROJECTED expert-profile row this loader is allowed to hold — six display columns, and
 * structurally NOT `rateCents` / `stripeConnectId` / `cronofyUserId`. Derived from the
 * repository so the two cannot drift.
 */
type RecapExpertProfile = NonNullable<
  Awaited<ReturnType<typeof expertsRepository.findDisplayProfileById>>
>;

interface CounterpartyLabels {
  party: RecapPartyView;
  /** Retrospective — person @ agency on first mention. Used by R11 and the R4 banner. */
  expertPersonLabel: string;
  /** Prospective — the expert PARTY short label, for action-item assignee chips. */
  expertPartyShort: string;
  /** The bare person/party name the resolve dialog copy uses. */
  expertShortName: string;
  /** The delivering expert's agency name, or `null` for an independent expert. */
  agencyLabel: string | null;
}

/**
 * The §R8 party card, both lenses.
 *
 * CLIENT LENS → the delivering EXPERT: photo, person name, headline, agency.
 * EXPERT LENS  → the client PARTY, i.e. the company. CLAUDE.md's attribution rule makes that
 * the right call rather than a shortcut: client-side rights sit on COMPANY membership and
 * survive individual departures, so there is no single client PERSON to name here. Nothing
 * evaluative appears on either side — the expert is not scoring the client, and BAL-422's
 * rating does not exist.
 */
async function resolveCounterparty(
  lens: RecapView['lens'],
  profile: RecapExpertProfile | undefined,
  clientCompanyName: string,
  ordinalLine: string | null
): Promise<CounterpartyLabels> {
  const [expertUser, agency] = await Promise.all([
    profile === undefined
      ? Promise.resolve(undefined)
      : usersRepository.findDisplayById(profile.userId),
    profile?.agencyId == null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);
  const agencyLabel = agency?.name ?? null;
  const firstName = expertUser?.firstName ?? null;
  const lastName = expertUser?.lastName ?? null;

  const expertPerson = personDisplayName(firstName, lastName, 'An expert');
  const expertPartyShort = expertPartyDisplayName({
    type: profile?.type ?? 'freelancer',
    agencyName: agencyLabel,
    firstName,
    lastName,
  });
  const shared = {
    expertPersonLabel: personWithOrgLabel(expertPerson, agencyLabel),
    expertPartyShort,
    expertShortName: personDisplayName(firstName, null, expertPartyShort),
    agencyLabel,
  };

  if (lens === 'client') {
    // ⚠ `expert_profiles.username` IS NULLABLE. A null username means NO CTA at all — never a
    // disabled button, and never an href pointing at `/experts/null`.
    const username = profile?.username ?? null;
    return {
      ...shared,
      party: {
        name: expertPerson,
        headline: profile?.headline ?? null,
        orgLabel: agencyLabel,
        avatarUrl: expertUser?.avatarUrl ?? null,
        initials: initialsOf(expertPerson),
        ordinalLine,
        bookAgainHref: username === null ? null : '/experts/' + username,
      },
    };
  }

  return {
    ...shared,
    party: {
      name: clientCompanyName,
      headline: null,
      orgLabel: null,
      avatarUrl: null,
      initials: initialsOf(clientCompanyName),
      ordinalLine,
      // ⚠ EVERY expert-side CTA the design listed (send proposal, private note, offer a new
      // time) has NO live destination today, so the card renders none. It must read complete
      // with one action or with zero — a disabled CTA is worse than an absent one.
      bookAgainHref: null,
    },
  };
}

/**
 * §R4 / §R9 — which shape the resolve prompt takes, who asked, and (once the case is closed)
 * the IN-PLACE success state. CLIENT LENS ONLY.
 *
 * ⚠⚠ `resolved` IS NOT THE ABSENCE OF A PROMPT. A card that simply unmounts after the one
 * irreversible action on the page leaves the milestone unconfirmed and the rail jumping; the
 * dialog has just promised a review link and nothing would corroborate it. So a CLOSED case
 * keeps its rail slot and states the outcome, driven off `closed_at`.
 *
 * ⚠ `reviewLinkSent` / `reviewWillBeAsked` ARE HONEST, NOT DECORATIVE. `resolveReviewAsk`
 * SKIPS the token when this reviewer already rated this expert on this engagement, and an
 * `auto_inactive` close mints none at all — so both the dialog fact and the success line are
 * keyed on the same read rather than promising an email that will not come.
 */
async function resolveResolveView(
  contextId: string,
  caseRow: CaseEngagementRow | undefined,
  isCase: boolean,
  labels: CounterpartyLabels,
  alreadyReviewed: boolean
): Promise<RecapResolveView> {
  const base = {
    engagementId: contextId,
    expertShortName: labels.expertShortName,
    reviewWillBeAsked: !alreadyReviewed,
    resolved: null,
  };
  if (!isCase || caseRow === undefined) {
    return { ...base, variant: 'none', requesterLabel: null };
  }
  if (caseRow.closedAt != null) {
    return {
      ...base,
      variant: 'none',
      requesterLabel: null,
      resolved: {
        reviewLinkSent: caseRow.closeReason !== 'auto_inactive' && !alreadyReviewed,
      },
    };
  }
  const requestedBy = caseRow.resolutionRequestedByUserId;
  if (caseRow.resolutionRequestedAt == null || requestedBy == null) {
    // ⚠ R4 AND R9 ARE MUTUALLY EXCLUSIVE. The page asks the resolve question exactly once, in
    // exactly one place: the banner when the expert asked, the quieter rail card otherwise.
    return { ...base, variant: 'offered', requesterLabel: null };
  }
  const [requester] = await usersRepository.findNamesByIds([requestedBy]);
  const requesterName = personDisplayName(
    requester?.firstName ?? null,
    requester?.lastName ?? null,
    labels.expertShortName
  );
  return {
    ...base,
    variant: 'requested',
    requesterLabel: personWithOrgLabel(requesterName, labels.agencyLabel),
  };
}

/** Read the summary + cleaned-transcript artefacts for a transcript, or two nulls. */
async function readArtifactContents(
  transcriptId: string | undefined
): Promise<{ summary: string | null; transcript: string | null }> {
  if (transcriptId === undefined) {
    return { summary: null, transcript: null };
  }
  const [summary, cleaned] = await Promise.all([
    transcriptArtifactsRepository.findByTranscriptAndKind(transcriptId, 'summary'),
    transcriptArtifactsRepository.findByTranscriptAndKind(transcriptId, 'cleaned'),
  ]);
  return { summary: summary?.content ?? null, transcript: cleaned?.content ?? null };
}

/**
 * Fetch the fee-concealed money block for a session. NEVER throws — a failure is the
 * fragment's OWN muted fallback (`null`), never a second error state on the page.
 */
async function readMoneyBlock(
  sessionId: string,
  meetingId: string,
  userId: string
): Promise<Awaited<ReturnType<typeof fetchSessionMoneyBlock>>> {
  try {
    return await fetchSessionMoneyBlock(sessionId);
  } catch (error) {
    log.error('Recap money block fetch failed', {
      meetingId,
      userId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

/**
 * Load the whole recap, or `null`.
 *
 * ⚠ ONE `null` FOR EVERY DENIAL — missing, soft-deleted, unauthorised, declined, ADMIN-ONLY
 * and ambiguous. The caller answers ONE `notFound()` with one copy, so the page never
 * confirms a meeting exists to somebody who may not read it.
 */
export const loadRecap = cache(
  async (meetingId: string, userId: string, now: Date = new Date()): Promise<RecapView | null> => {
    const access: RecapAccess | null = await resolveRecapAccess(meetingId, userId);
    if (access === null) {
      return null;
    }

    const { meeting, subject, companyId, expertProfileId, lens } = access;

    // ⚠⚠ A MEETING THAT HAS NOT HAPPENED HAS NO RECAP, AND THE ANSWER IS `null`.
    // The read gate deliberately does NOT discharge lifecycle, so a participant can reach this
    // URL while the meeting is still `scheduled` / `waiting_for_participants` / `in_progress`.
    // Rendering the shell then states FOUR falsehoods at once: a green "Completed" chip over a
    // FUTURE date, "no consultation charge for this one", "this call was not written up", and a
    // resolve offer for a consultation nobody has had. A "Scheduled" chip would fix exactly one
    // of the four; the other three are absences this page has no honest copy for, and there is
    // no upcoming-meeting surface to redirect to (BAL-134 / BAL-421 own that). So the recap
    // simply does not exist yet, and it collapses into the SAME single `null` ⇒ `notFound()`
    // every other denial uses. Nothing links here before then: `recap.ready` publishes only
    // after the transcript pipeline runs. `cancelled` DOES render, as the R11 not-held panel.
    if (meeting.status !== 'ended' && meeting.status !== 'cancelled') {
      return null;
    }

    const contextType: RecapContextType = subject.contextType;
    const isCase = contextIsCase(contextType);
    const isEngagementGrain = ENGAGEMENT_GRAIN.has(contextType);

    const [
      files,
      actionItems,
      transcript,
      session,
      company,
      profile,
      caseRow,
      siblings,
      existingReview,
    ] = await Promise.all([
      meetingFilesRepository.listByMeeting(meetingId),
      actionItemsRepository.listByMeeting(meetingId),
      transcriptsRepository.findByMeetingId(meetingId),
      isCase ? creditSessionsRepository.findIdByMeetingId(meetingId) : Promise.resolve(undefined),
      companiesRepository.findNameById(companyId),
      expertProfileId === null
        ? Promise.resolve(undefined)
        : expertsRepository.findDisplayProfileById(expertProfileId),
      isCase
        ? caseEngagementsRepository.findByEngagementId(subject.contextId)
        : Promise.resolve(undefined),
      isCase
        ? meetingContextsRepository.listMeetingsForContext('case', subject.contextId)
        : Promise.resolve<Meeting[]>([]),
      // Has THIS viewer already rated THIS expert on THIS engagement? One indexed read, and it
      // is what keeps two pieces of copy true: the dialog's "we'll send you a short review link"
      // and the post-resolve confirmation. `resolveReviewAsk` skips the token in exactly this
      // case, so promising the email regardless would be a promise the platform does not keep.
      isCase && lens === 'client' && expertProfileId !== null
        ? reviewsRepository.findLive(subject.contextId, userId, expertProfileId)
        : Promise.resolve(undefined),
    ]);

    const clientCompanyName = company?.name ?? 'the client';
    const alreadyReviewed = existingReview !== undefined;

    // ⚠ THE SIBLING SET IS NARROWED **HERE**, not downstream: `dailyRoomName` and `joinUrl`
    // never leave this function, and the derivation returns two numbers.
    const { ordinal } = deriveConsultationOrdinal(
      siblings.map((row) => ({
        id: row.id,
        scheduledStart: row.scheduledStart,
        startedAt: row.startedAt,
        status: row.status,
        outcome: row.outcome,
      })),
      meetingId
    );

    // Independent reads, run together — no waterfall.
    const [title, artifactContents, fileRows, labels, moneyBlock] = await Promise.all([
      resolveTitle(contextType, subject.contextId, caseRow),
      readArtifactContents(transcript?.id),
      mapRecapFiles(files, userId),
      resolveCounterparty(
        lens,
        profile,
        clientCompanyName,
        isCase ? formatOrdinalLine(ordinal) : null
      ),
      session === undefined ? Promise.resolve(null) : readMoneyBlock(session.id, meetingId, userId),
    ]);

    const artifacts = resolveArtifacts({
      transcriptStatus: (transcript?.status ?? null) as TranscriptStatusLike | null,
      summaryContent: artifactContents.summary,
      transcriptContent: artifactContents.transcript,
      awaitingPipeline:
        meeting.endedAt !== null && now.getTime() - meeting.endedAt.getTime() < PIPELINE_GRACE_MS,
    });

    const notHeld = resolveNotHeld({
      status: meeting.status,
      outcome: meeting.outcome,
      lens,
      expertPersonLabel: labels.expertPersonLabel,
      clientCompanyName,
    });

    const durationMinutes = durationMinutesOf(meeting);

    // ⚠ RULE M — keyed on the PRESENCE of a `credit_sessions` row, never on a duration and
    // never on a policy. Non-case contexts carry no per-meeting money at all.
    const money = isCase
      ? resolveMoneyView({
          hasSession: session !== undefined,
          block: moneyBlock,
          elapsedMinutes: durationMinutes ?? 0,
        })
      : null;

    const header: RecapHeaderView = {
      eyebrow: resolveEyebrow(contextType),
      // ⚠ BAL-421 — the recap's back link to its case. Only the `case` context's `contextId`
      // IS an `engagements.id`, so every other context yields `null` and NO link renders
      // (never a disabled one).
      //
      // ⚠ NO `?from=recap`, DELIBERATELY. The case→recap direction DOES carry
      // `?from=case_surface`, because `RecapEntrySource` declares that value and
      // `resolveEntrySource` reads it. Nothing reads a `from` param on `/cases/{id}`:
      // `case_surface_viewed` carries lens / consultation_count / case_state and has no
      // `source` dimension. Appending one anyway would be an unread query string that LOOKS
      // like instrumentation — the same "reads as coverage that does not exist" failure the
      // no-producer rule forbids for enum values. Add the param in the change that reads it.
      caseHref: isCase ? '/cases/' + subject.contextId : null,
      title,
      status: resolveStatus(meeting, caseRow, artifacts.summary.state === 'processing'),
      closedNote: resolveClosedNote(caseRow),
      occurredAtIso: (meeting.startedAt ?? meeting.scheduledStart).toISOString(),
      durationMinutes,
      openActionItemCount: countOpenActionItems(actionItems),
      totalActionItemCount: actionItems.length,
    };

    const panel = isEngagementGrain
      ? mapRecapActionItems({
          engagementId: subject.contextId,
          actionItems,
          lens,
          clientCompanyName,
          expertPartyShort: labels.expertPartyShort,
          // ⚠⚠ READ-ONLY ON THIS SURFACE, AND THAT IS HONESTY RATHER THAN CAUTION. Every
          // action-item MUTATION gates through `gateEngagementParticipant` ⇒
          // `projectEngagementsRepository.findWithMilestones`, whose query filters
          // `engagement_type = 'project'`, so a CASE id can never resolve and toggle / assign /
          // edit / remove would toast "This engagement could not be found" on EVERY click. A
          // panel whose controls always error is worse than a panel that does not offer them.
          // The other three engagement-grain contexts have no producer at all today, so the
          // rule is stated once for all of them rather than split. Making the gate case-aware is
          // the follow-up that turns this back on — and whoever does it owes this surface a
          // SUPPRESSED ADD ROW: the panel's add-path writes an ENGAGEMENT-grain item with
          // `meeting_id = NULL`, which this MEETING-scoped list would not show, so a writable
          // recap would make a just-added item vanish on submit.
          canWrite: false,
          now,
        })
      : null;

    const base = {
      meetingId,
      contextType,
      state: resolveRecapState({ notHeld, artifacts }),
      header,
      money,
      artifacts,
      actionItems: panel,
      party: labels.party,
      files: fileRows,
      notHeld,
    };

    // ⚠⚠ THE LENS IS A DISCRIMINANT. The expert arm is CONSTRUCTED WITHOUT a `resolve` field,
    // so there is no optional property for a bug to populate — and `expert-recap.tsx` never
    // references the banner or the wrap-up card. Structural, not conditional.
    if (lens === 'expert') {
      return { ...base, lens: 'expert' };
    }
    return {
      ...base,
      lens: 'client',
      resolve: await resolveResolveView(
        subject.contextId,
        caseRow,
        isCase,
        labels,
        alreadyReviewed
      ),
    };
  }
);
