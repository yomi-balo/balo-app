/**
 * BAL-134 — **WHO IS ACTUALLY DELIVERING THIS MEETING**, in one place.
 *
 * ⚠⚠ THIS IS NOT AN AUTHORIZATION SEAM AND MUST NEVER BE USED AS ONE. It answers a question of
 * FACT — "which human is the consultant on this booking, and what party do they trade as" — and
 * it applies no tenancy check of any kind. `resolveHostContext`'s header block calls the same
 * shape an IDENTITY ORACLE, and the warning carries over verbatim: `meeting_contexts.context_id`
 * has no FK and no RLS, so a caller holding an unvetted `meetingId` gets a truthful answer about
 * somebody else's expert. Every caller here already holds a meeting row it resolved itself.
 *
 * ── WHY THE DELIVERY IDENTITY IS A SEPARATE QUESTION FROM THE PARTICIPATION GATE ─────────
 *
 * `authorizeMeetingParticipation` answers "which SIDE is this actor on", and its expert arm is
 * `MANAGE_ENGAGEMENT` — the delivering expert **plus their agency `owner`/`admin`**. That is the
 * correct ACT set (ADR-1046 §7) and the wrong BILLING set, in both directions:
 *
 *   · TOO WIDE — an agency owner who is not the consultant would be written `party: 'expert'`,
 *     which anchors `expertPresentMs`, disarms the missed-call rule and starts `billableMs`
 *     without the assigned expert ever delivering. BAL-134's AC says in as many words that "an
 *     expert-side guest **or agency colleague** joining does not" start billing, and
 *     `presencePartyForGuest` already enforces exactly that for the GUEST identity kind — so the
 *     authenticated path disagreeing with the guest path was the two identity kinds giving
 *     different answers to one money question.
 *   · TOO NARROW — `relationshipDeniesHosting` strips BOTH engagement tokens from the delivering
 *     expert of a DECLINED request-grain relationship. That expert can still be physically in a
 *     `project_discovery` / `request_interaction` call booked before the decline, and recording
 *     them `observer` leaves `expertEverPresent` false, fires the missed-call rule at
 *     `scheduledStart + 10min`, and DELETES THE DAILY ROOM WHILE BOTH PARTIES ARE TALKING.
 *
 * So `party` is resolved from DELIVERY IDENTITY, and the participation gate is consulted only
 * for the client side. Both readings stay correct because they are now two different questions
 * asked of two different seams.
 *
 * ⚠ `findDisplayProfileById`, NOT `findProfileById`. The display read projects eight columns and
 * structurally cannot carry `rateCents` (the un-marked-up consultant rate), `stripeConnectId` or
 * `cronofyUserId`. Nothing here renders, but the narrow read is free and keeps those columns off
 * a code path that touches a notification payload.
 */
import {
  agenciesRepository,
  expertsRepository,
  meetingContextsRepository,
  resolveMeetingContextOwner,
  usersRepository,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { selectPrimaryMeetingContext } from '@balo/shared/meetings';

const log = createLogger('meeting-delivering-party');

/**
 * The `users.id` of the consultant a booking names — `expert_profiles.userId` for the profile
 * the meeting's context resolves to.
 *
 * `null` for: no expert profile on the context (a `match`-routed `project_discovery` or an
 * `admin` meeting name nobody), or a profile row that is gone. Both are real answers, and both
 * mean "this meeting has no delivering identity", never "look somewhere else".
 */
export async function deliveringExpertUserId(
  expertProfileId: string | null
): Promise<string | null> {
  if (expertProfileId === null) {
    return null;
  }
  const profile = await expertsRepository.findDisplayProfileById(expertProfileId);
  if (profile === undefined) {
    // An integrity signal, not a routine deny: a context named a profile that does not exist.
    log.warn({ expertProfileId }, 'Meeting context names an expert profile that is not there');
    return null;
  }
  return profile.userId;
}

/**
 * The expert profile the MEETING resolves to, through its own primary context.
 *
 * ⚠ SAME PRECEDENCE RULE AS EVERY OTHER READER (`selectPrimaryMeetingContext`), so a meeting
 * carrying two context rows resolves to the same one here as it does at the participation gate.
 * A second precedence rule would be a second answer to "what is this meeting about".
 */
export async function deliveringExpertProfileIdForMeeting(
  meetingId: string
): Promise<string | null> {
  const primary = selectPrimaryMeetingContext(
    await meetingContextsRepository.listByMeeting(meetingId)
  );
  if (!primary.ok) {
    return null;
  }
  const owner = await resolveMeetingContextOwner(primary.context);
  return owner?.expertProfileId ?? null;
}

/**
 * The PARTY a client should be told is waiting for them — the expert's AGENCY, or an independent
 * expert's own name.
 *
 * ⚠ CLAUDE.md'S PROSPECTIVE-ATTRIBUTION RULE, APPLIED LITERALLY. Copy about who is waiting is
 * prospective, so it names the PARTY: "CloudPeak is in the room", never "Sam is in the room" for
 * an agency-based expert. An INDEPENDENT expert (null `agencyId`) is their own party and keeps
 * their own name — the same split `expert_profiles.agencyId` already draws everywhere else.
 *
 * ⚠ `null` IS A FIRST-CLASS ANSWER AND THE TEMPLATES RENDER PARTY-NEUTRAL COPY FOR IT. Inventing
 * a name on a delivery surface would be a lie; "Your expert is in the room" is true regardless.
 */
export async function deliveringPartyName(expertProfileId: string | null): Promise<string | null> {
  if (expertProfileId === null) {
    return null;
  }
  const profile = await expertsRepository.findDisplayProfileById(expertProfileId);
  if (profile === undefined) {
    return null;
  }

  if (profile.agencyId !== null) {
    const agency = await agenciesRepository.getSummaryById(profile.agencyId);
    return nonEmpty(agency?.name);
  }

  const user = await usersRepository.findById(profile.userId);
  if (user === undefined) {
    return null;
  }
  return nonEmpty([user.firstName, user.lastName].filter(Boolean).join(' '));
}

/** A blank name is the same as no name — never a rendered empty string. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
