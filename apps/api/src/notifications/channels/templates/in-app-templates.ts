import {
  formatAudMinor,
  formatExpiryDateShort,
  buildSavedCardDetachedCopy,
} from './credit-format.js';
import { buildBillingEmailChangedCopy } from './billing-email-changed.js';
import { calendarProviderLabel } from '../../../lib/apiroc/provider-labels.js';
import { pluralize } from './shared.js';
import { EXPERT_CALENDAR_SETTINGS_PATH } from '@balo/shared/calendar';
import { personWithOrgLabel } from '@balo/shared/parties';

interface InAppOutput {
  title: string;
  body: string;
  actionUrl?: string;
}

/** Coerce a merged-payload numeric field to a number; 0 when absent/non-numeric. */
function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Length of an array-valued payload field; 0 when absent or not an array. */
function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * BAL-410 — the client-side cancellation opening sentence, extracted so the body assembly stays
 * a single expression and SonarCloud's no-nested-ternary rule is satisfied structurally rather
 * than by formatting.
 *
 * Three arms, in precedence order: the client's own act, the expert's time-off variant, and the
 * ordinary "somebody cancelled it" case. All gender-neutral, all non-adversarial.
 */
function resolveClientCancelOpening(
  cancelledByClient: boolean,
  timeOff: boolean,
  labels: { expertParty: string; cancelledByLabel: string }
): string {
  if (cancelledByClient) {
    return `You cancelled your consultation with ${labels.expertParty}.`;
  }
  if (timeOff) {
    return `Your consultation with ${labels.expertParty} was cancelled — that time is no longer available.`;
  }
  return `${labels.cancelledByLabel} cancelled your consultation.`;
}

/**
 * BAL-412 (F16, ADR-1044 §7) — the IN-APP half of the no-show notice; the email half is
 * `noShowClientSentence` in `./index.ts`.
 *
 * ⚠ THE TWO ARE DELIBERATELY SEPARATE, NOT A MISSED EXTRACTION. An in-app body is a single short
 * line appended to an existing sentence; the email is a standalone body line with room for the
 * waited duration. Sharing one string would force one register to fit the other's budget, and
 * the copy — not the mechanism — is the whole point of this notice.
 *
 * Same rules as the email: FACTUAL, NEVER PUNITIVE, GENDER-NEUTRAL, no individual named on
 * either side, no penalty implied (D2/D8). Fee-safe — a shape label and the SNAPSHOTTED floor
 * (`billing_floor_minutes`), never a second money figure. Returns `''` (appends nothing) for
 * every other shape and for every `live_capture` / `external` / pre-0071 row.
 */
function noShowClientClause(
  data: Record<string, unknown>,
  lens: 'client' | 'expert',
  expertName?: string
): string {
  if (data.settlementShape !== 'no_show_client') {
    return '';
  }
  const floorMinutes = numberOrZero(data.billingFloorMinutes);
  if (lens === 'expert') {
    // ⚠ Never says "client" — the expert-lens fee boundary is asserted on the whole body string
    // (`case-billing-templates.test.ts`), and naming the absent party would read as blame.
    return ` Settled as a no-show — your time is recorded at the ${floorMinutes}-minute minimum.`;
  }
  const who = expertName ?? 'your consultant';
  return ` No one from your side joined — ${who} was there and waiting, so it settles at the ${floorMinutes}-minute minimum.`;
}

/**
 * Format a minor-unit price (cents) + currency code for an in-app body, e.g.
 * `formatPriceCents(120000, 'aud') === 'AUD 1,200'`. Guards both fields: a
 * non-number price or absent currency degrades gracefully rather than rendering
 * `NaN`/`undefined`. No external money library — inline by design.
 */
function formatPriceCents(priceCents: unknown, currency: unknown): string {
  const code = typeof currency === 'string' && currency.length > 0 ? currency.toUpperCase() : '';
  if (typeof priceCents !== 'number' || !Number.isFinite(priceCents)) {
    return code || 'an amount';
  }
  const amount = (priceCents / 100).toLocaleString();
  return code ? `${code} ${amount}` : amount;
}

/**
 * BAL-345 — the joiner/requester display name from the resolver-hydrated
 * `data.user` (payload.userId). Degrades to "A teammate" when the name is unset.
 */
function partyMemberName(data: Record<string, unknown>): string {
  const user = data.user as { firstName?: string | null; lastName?: string | null } | undefined;
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'A teammate';
}

/**
 * BAL-424 — the deep link for a conversation notice, CHOSEN BY THE ANCHOR.
 *
 * `relationship` → the project request; `engagement` → the delivery workspace. A Case has NO
 * request, so the old unconditional `/projects/${projectRequestId}` would have produced a
 * dead link (or none at all) for exactly the surface this ticket generalises the event for.
 * Falls back to no link rather than to a wrong one.
 *
 * ⚠ TODO(BAL-421) — `/engagements/[id]` CURRENTLY FILTERS `engagement_type = 'project'`, so
 * this path 404s for a case / package / retainer thread. UNREACHABLE TODAY: all four
 * producers (`post-conversation-message.ts`, `confirm-case-file-upload.ts`, and the
 * digest's two arms) hard-code `contextType: 'relationship'`, so only the `/projects/{id}`
 * branch is ever taken. BAL-421 ships the case surface and owns widening that route — the
 * link is written to the shape the plan specified rather than redesigned here.
 */
function conversationActionUrl(data: Record<string, unknown>): string | undefined {
  if (data.contextType === 'engagement') {
    const engagementId = (data.engagementId ?? data.contextId) as string | undefined;
    return engagementId ? `/engagements/${engagementId}` : undefined;
  }
  const projectRequestId = data.projectRequestId as string | undefined;
  return projectRequestId ? `/projects/${projectRequestId}` : undefined;
}

/** BAL-345 — human noun for the party type carried in `data.partyType`. */
function partyTypeNoun(data: Record<string, unknown>): string {
  if (data.partyType === 'company') return 'company';
  if (data.partyType === 'agency') return 'agency';
  return 'organization';
}

/**
 * BAL-348 — the approved/declined in-app deep-link. Lands the requester on the
 * `/onboarding/join-result` terminal screen, which RE-VALIDATES the party
 * relationship server-side (the `status`/`party` query params are never trusted).
 *
 * The landing surface is COMPANY-ONLY (it reads `companiesRepository.findById` and
 * gates on `PARTY_TYPE = 'company'`), but `party.join_request_approved/declined` are
 * defined for BOTH company and agency parties. So the landing link is emitted only for
 * a company party; an agency party (or a payload with no `partyId`) falls back to
 * `/dashboard` for approved and omits the link for declined (its terminal screen offers
 * "create your own" — no dead-end).
 */
function joinResultActionUrl(
  status: 'approved' | 'declined',
  data: Record<string, unknown>
): string | undefined {
  const partyId = data.partyId;
  if (data.partyType !== 'company' || typeof partyId !== 'string' || partyId.length === 0) {
    return status === 'approved' ? '/dashboard' : undefined;
  }
  return `/onboarding/join-result?status=${status}&party=${partyId}`;
}

/** The common in-app shape: title + body linking to the project request. */
function projectRequestNotice(
  title: string,
  body: string,
  data: Record<string, unknown>
): InAppOutput {
  const projectRequestId = data.projectRequestId as string | undefined;
  return { title, body, actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined };
}

/** BAL-332 — the common in-app shape for a milestone notice, deep-linked to the workspace. */
function engagementNotice(title: string, body: string, data: Record<string, unknown>): InAppOutput {
  const engagementId = data.engagementId as string | undefined;
  return { title, body, actionUrl: engagementId ? `/engagements/${engagementId}` : undefined };
}

/** BAL-332 — "n/m" milestone progress from the payload counts; "" when either is absent. */
function milestoneProgress(data: Record<string, unknown>): string {
  const done = data.completedCount;
  const total = data.totalCount;
  return typeof done === 'number' && typeof total === 'number' ? `${done}/${total}` : '';
}

const templates: Record<string, (data: Record<string, unknown>) => InAppOutput> = {
  // BAL-400 (D4) — a consultation was booked into a case. The CLIENT in-app notice: prospective
  // copy names the PARTY (`expertPartyLabel`), never a pronoun. Deep-links to the case, never to
  // `/meeting/:id` (that route does not exist — `meetings.join_url` is the raw Daily URL and
  // never crosses to the client).
  'booking-confirmed-client': (data) => {
    const expertParty = (data.expertPartyLabel as string) ?? 'Your expert';
    const engagementId = data.engagementId as string | undefined;
    const isNewCase = data.isNewCase === true;
    return {
      title: 'Consultation confirmed',
      body: isNewCase
        ? `Your consultation with ${expertParty} is confirmed.`
        : `Another consultation with ${expertParty} is confirmed.`,
      actionUrl: engagementId ? `/cases/${engagementId}` : undefined,
    };
  },

  // BAL-400 (D4) — the EXPERT half of the same event: prospective copy names the CLIENT PARTY
  // (`clientCompanyName`), never an invented individual.
  'booking-confirmed-expert': (data) => {
    const clientCompany = (data.clientCompanyName as string) ?? 'A client';
    const engagementId = data.engagementId as string | undefined;
    const isNewCase = data.isNewCase === true;
    return {
      title: 'New booking',
      body: isNewCase
        ? `${clientCompany} booked a consultation with you.`
        : `${clientCompany} booked another consultation with you.`,
      actionUrl: engagementId ? `/cases/${engagementId}` : undefined,
    };
  },

  // BAL-409 — the CLIENT half of `booking.rescheduled`: prospective copy names the expert
  // PARTY, matching `booking-confirmed-client`'s posture. Never `/meeting/:id` (no such route)
  // and never `meetings.join_url`.
  // BAL-411 — `initiatedBy` now branches the body: the expert-initiated arm ("you confirmed a
  // new time") is what the client sees right after THEY accepted the expert's proposal — the
  // client just acted, so the copy says so rather than presenting it as something that
  // happened to them.
  'booking-rescheduled-client': (data) => {
    const expertParty = (data.expertPartyLabel as string) ?? 'Your expert';
    const engagementId = data.engagementId as string | undefined;
    const initiatedBy = data.initiatedBy === 'expert' ? 'expert' : 'client';
    return {
      title: 'Consultation moved',
      body:
        initiatedBy === 'expert'
          ? `You confirmed a new time with ${expertParty}.`
          : `Your consultation with ${expertParty} was moved to a new time.`,
      actionUrl: engagementId ? `/cases/${engagementId}` : undefined,
    };
  },

  // BAL-409 — the EXPERT half of the same event: prospective copy names the CLIENT PARTY.
  // BAL-411 — `initiatedBy` now branches the body: the expert-initiated arm ("accepted your
  // new time") is what the expert sees when the CLIENT accepted the expert's OWN proposal.
  'booking-rescheduled-expert': (data) => {
    const clientCompany = (data.clientCompanyName as string) ?? 'A client';
    const engagementId = data.engagementId as string | undefined;
    const initiatedBy = data.initiatedBy === 'expert' ? 'expert' : 'client';
    return {
      title: 'Booking moved',
      body:
        initiatedBy === 'expert'
          ? `${clientCompany} accepted your new time.`
          : `${clientCompany} moved a consultation with you to a new time.`,
      actionUrl: engagementId ? `/cases/${engagementId}` : undefined,
    };
  },

  // BAL-410 — the CLIENT half of `booking.cancelled`. ⚠ ALSO what the `meeting_party_participants`
  // fan-out arm renders: those recipients ARE the client side.
  //
  // ⚠⚠ THIS IS THE **ONLY** SURFACE THAT MENTIONS THE HOLD, AND ONLY WHEN ONE WAS ACTUALLY
  // RELEASED. The ticket: "Hold released → client → in-app only. Not email — no money moved, and
  // an email implies something went wrong." `holdReleased` is `false` in the overwhelmingly
  // common case (nobody joined early), so the line is APPENDED rather than always present —
  // claiming a release that did not happen would be a money statement that is simply untrue.
  'booking-cancelled-client': (data) => {
    const expertParty = (data.expertPartyLabel as string) ?? 'Your expert';
    const cancelledByLabel = (data.cancelledByLabel as string) ?? expertParty;
    const engagementId = data.engagementId as string | undefined;
    const cancelledByClient = data.cancelledBy === 'client';
    const timeOff = data.reason === 'expert_time_off';
    const opening = resolveClientCancelOpening(cancelledByClient, timeOff, {
      expertParty,
      cancelledByLabel,
    });
    return {
      title: 'Consultation cancelled',
      body:
        data.holdReleased === true
          ? `${opening} Nothing was charged, and the credit we were holding is back in your balance.`
          : `${opening} Nothing was charged.`,
      actionUrl: engagementId ? `/cases/${engagementId}` : undefined,
    };
  },

  // BAL-410 — the EXPERT half. Prospective copy names the client COMPANY; retrospective copy
  // names the person who cancelled. ⚠ NO hold language on this side at all — the hold is the
  // CLIENT's money and the expert has no business being told about its state.
  'booking-cancelled-expert': (data) => {
    const clientCompany = (data.clientCompanyName as string) ?? 'A client';
    const cancelledByLabel = (data.cancelledByLabel as string) ?? clientCompany;
    const engagementId = data.engagementId as string | undefined;
    return {
      title: 'Booking cancelled',
      body:
        data.cancelledBy === 'expert'
          ? `You cancelled a consultation with ${clientCompany}. That slot is open again.`
          : `${cancelledByLabel} cancelled a consultation with you. That slot is open again.`,
      actionUrl: engagementId ? `/cases/${engagementId}` : undefined,
    };
  },

  // BAL-411 — the expert proposed alternative times. Prospective copy names the expert PARTY,
  // matching `booking-rescheduled-client`'s posture.
  'reschedule-proposal-sent': (data) => {
    const expertParty = (data.expertPartyLabel as string) ?? 'Your expert';
    const engagementId = data.engagementId as string | undefined;
    return {
      title: 'New time suggested',
      body: `${expertParty} suggested a few other times for your consultation.`,
      actionUrl: engagementId ? `/cases/${engagementId}` : undefined,
    };
  },

  // BAL-411 — the client declined every option. Retrospective copy names the person who
  // answered, with "@ company" on first mention.
  'reschedule-proposal-declined': (data) => {
    const declinedBy = (data.declinedByLabel as string) ?? 'The client';
    const engagementId = data.engagementId as string | undefined;
    return {
      title: 'Original time kept',
      body: `${declinedBy} kept the original time.`,
      actionUrl: engagementId ? `/cases/${engagementId}` : undefined,
    };
  },

  // BAL-411 — the BAL-420 reminder: still unanswered as the original start closes in.
  // Prospective copy names the expert PARTY. Deadline stated as a helpful fact, never a
  // countdown.
  'reschedule-proposal-unanswered': (data) => {
    const expertParty = (data.expertPartyLabel as string) ?? 'Your expert';
    const engagementId = data.engagementId as string | undefined;
    return {
      title: 'A time suggestion is waiting',
      body: `${expertParty}'s suggested times are still open — pick one, or keep your original booking.`,
      actionUrl: engagementId ? `/cases/${engagementId}` : undefined,
    };
  },

  // BAL-283 (Ruling 3) — the expert shared availability on a project-request thread.
  // Retrospective copy names the PERSON with "@ party" on first mention (CLAUDE.md). Deep-links
  // the CONVERSATION, never a raw booking deep link — one entry point into the dialog.
  //
  // ⚠ `personWithOrgLabel`, NEVER `` `${person} @ ${party}` `` (round-1 W1): for an INDEPENDENT
  // expert the party label IS the person's own name, and the hand-concatenation rendered
  // "Dana Okoro @ Dana Okoro". ⚠ AND NO `'their agency'` PLACEHOLDER (round-1 W2) — this file's
  // sibling `templates/index.ts` carries the standing warning against exactly that string; the
  // honest fallback for a missing party label is the person's own name.
  'availability-shared-client': (data) => {
    const expertPersonName = (data.expertPersonName as string) ?? 'An expert';
    const expertPartyLabel = (data.expertPartyLabel as string) ?? expertPersonName;
    const requestId = data.requestId as string | undefined;
    return {
      title: 'An expert is ready to talk',
      body: `${personWithOrgLabel(expertPersonName, expertPartyLabel)} shared their availability — pick a time.`,
      actionUrl: requestId ? `/projects/${requestId}` : undefined,
    };
  },

  // BAL-283 — the CLIENT half of `conversation.intro_call_booked`. Names the expert PARTY,
  // matching `booking-confirmed-client`'s posture (the client already knows who they booked —
  // the party is the useful identifier). No money field to leak.
  'intro-call-booked-client': (data) => {
    const expertParty = (data.expertPartyLabel as string) ?? 'your expert';
    const requestId = data.requestId as string | undefined;
    return {
      title: 'Intro call confirmed',
      body: `Your intro call with ${expertParty} is confirmed.`,
      actionUrl: requestId ? `/projects/${requestId}` : undefined,
    };
  },

  // BAL-283 — the EXPERT half of the same event.
  //
  // ⚠ RETROSPECTIVE, NOT PROSPECTIVE (round-1 MAJOR UX). A completed action reported after the
  // fact is retrospective, so it names the PERSON "@ company" on first mention (CLAUDE.md) —
  // the earlier comment here mislabelled "booked" as prospective and the copy followed it,
  // telling the expert only *that* someone from the company booked, never *who*.
  'intro-call-booked-expert': (data) => {
    const clientPerson = (data.clientPersonName as string) ?? 'A client';
    const requestId = data.requestId as string | undefined;
    return {
      title: 'New intro call booked',
      body: `${personWithOrgLabel(clientPerson, data.clientCompanyName as string)} booked an intro call with you.`,
      actionUrl: requestId ? `/projects/${requestId}` : undefined,
    };
  },

  // BAL-431 / ADR-1048 — a CLIENT shared a file with one candidate track.
  //
  // ⚠⚠ NO AUDIENCE, TRACK-COUNT OR SIBLING NAME MAY EVER APPEAR HERE (ADR-1048 §3) — this
  // in-app body is exactly as audience-shaped as the expert serializer, and `getInAppTemplate`
  // never throws on a miss, so a typo'd template name here silently ships generic copy rather
  // than a build failure.
  'request-file-shared-expert': (data) => {
    const clientCompanyName = (data.clientCompanyName as string) ?? 'The client';
    const requestId = data.requestId as string | undefined;
    return {
      title: 'New file shared',
      body: `${clientCompanyName} shared a file on this request.`,
      actionUrl: requestId ? `/projects/${requestId}` : undefined,
    };
  },

  // BAL-431 — the mirror: an EXPERT uploaded to their own track, notifying the client contact.
  'request-file-shared-client': (data) => {
    const expertPartyLabel = (data.expertPartyLabel as string) ?? 'Your expert';
    const requestId = data.requestId as string | undefined;
    return {
      title: `New file from ${expertPartyLabel}`,
      body: `${expertPartyLabel} shared a file on this request.`,
      actionUrl: requestId ? `/projects/${requestId}` : undefined,
    };
  },

  'new-message': (data) => {
    const caseId = data.caseId as string | undefined;
    return {
      title: 'New message',
      body: 'You have a new message in your consultation',
      actionUrl: caseId ? `/cases/${caseId}` : undefined,
    };
  },

  'project-exploratory-requested': (data) => {
    const title = (data.title as string) ?? 'your project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Book your exploratory call',
      body: `Balo wants a quick call about "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-expert-invited': (data) => {
    const title = (data.title as string) ?? 'a new project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: "You're invited to a project",
      body: `Balo invited you to express interest in "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-eoi-submitted': (data) => {
    const title = (data.title as string) ?? 'your project';
    const expertName = (data.expertName as string) ?? 'An expert';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'An expert is interested',
      body: `${expertName} expressed interest in "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-requested': (data) => {
    const title = (data.title as string) ?? 'a project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal requested',
      body: `The client requested your proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  // BAL-315: client heads-up when an admin requested a proposal on their behalf.
  'project-proposal-requested-client': (data) => {
    const title = (data.title as string) ?? 'your project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal requested for you',
      body: `Balo asked an expert to send a proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-submitted': (data) => {
    const title = (data.title as string) ?? 'a project';
    const expertName = (data.expertName as string) ?? 'Your expert';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal received',
      body: `${expertName} sent a proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-accepted': (data) => {
    const title = (data.title as string) ?? 'a project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal accepted',
      body: `Your proposal for "${title}" was accepted`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-kickoff-approved-expert': (data) => {
    const title = (data.title as string) ?? 'a project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Kickoff approved',
      body: `Kickoff approved for "${title}" — time to deliver`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-kickoff-approved-client': (data) => {
    const title = (data.title as string) ?? 'a project';
    const expertName = (data.expertName as string) ?? 'Your expert';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Kickoff approved',
      body: `${expertName} is ready — kickoff approved for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-not-selected': (data) => {
    const title = (data.title as string) ?? 'a project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal not selected',
      body: `The client chose another proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-changes-requested': (data) => {
    const title = (data.projectTitle as string) ?? 'a project';
    const clientName = (data.clientName as string) ?? 'The client';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Changes requested',
      body: `${clientName} requested changes to your proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-resubmitted': (data) => {
    const title = (data.projectTitle as string) ?? 'a project';
    const expertName = (data.expertName as string) ?? 'Your expert';
    const version = typeof data.version === 'number' ? data.version : undefined;
    const projectRequestId = data.projectRequestId as string | undefined;
    const versionLabel = version ? ` (v${version})` : '';
    return {
      title: 'Updated proposal',
      body: `${expertName} sent an updated proposal${versionLabel} for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-accepted-admin': (data) => {
    const clientName = (data.clientName as string) ?? 'A client';
    const company = (data.clientCompanyName as string) ?? '';
    // First-mention "Name @ Company" rule; degrade to the bare name when absent.
    const who = company ? `${clientName} @ ${company}` : clientName;
    const title = (data.title as string) ?? 'a project';
    const amount = formatPriceCents(data.priceCents, data.currency);
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal accepted — raise invoice',
      body: `${who} accepted a proposal for "${title}" (${amount})`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  // BAL-345 domain auto-join. `data.user` (the joiner/requester) is hydrated by
  // the resolver from payload.userId; `data.partyType` names the party. member/
  // request notices go to party admins; approved/declined go to the requester.
  'party-member-joined-via-domain': (data) => {
    const actorName = partyMemberName(data);
    return {
      title: 'New teammate joined',
      body: `${actorName} joined your ${partyTypeNoun(data)} via a matched email domain`,
      actionUrl: '/settings/team',
    };
  },

  'party-join-request-created': (data) => {
    const actorName = partyMemberName(data);
    return {
      title: 'Join request',
      body: `${actorName} requested to join your ${partyTypeNoun(data)}`,
      actionUrl: '/settings/team',
    };
  },

  // BAL-348: the deep-link now lands the requester on the join-result terminal screen
  // (was /dashboard) so a request-mode requester who never finished onboarding reaches
  // the correct "you're in" screen. The route re-validates membership server-side.
  'party-join-request-approved': (data) => ({
    title: "You're in",
    body: `Your request to join the ${partyTypeNoun(data)} was approved`,
    actionUrl: joinResultActionUrl('approved', data),
  }),

  // BAL-348: adds a deep-link (was none) to the declined terminal screen, which offers
  // the "create your own company" action.
  'party-join-request-declined': (data) => ({
    title: 'Request declined',
    body: `Your request to join the ${partyTypeNoun(data)} was not approved`,
    actionUrl: joinResultActionUrl('declined', data),
  }),

  // BAL-348 agency provisioned — owner in-app milestone. `data.agency` is the
  // resolver-hydrated summary (name only). Deep-links to team/members settings.
  'agency-provisioned': (data) => {
    const agency = data.agency as { name?: string } | undefined;
    const teamName = agency?.name ?? 'Your team';
    return {
      title: 'Your team is set up',
      body: `${teamName} is on Balo — colleagues who sign up with your email domain will join automatically.`,
      actionUrl: '/settings/team',
    };
  },

  // BAL-396 §7 (Objection 5) — `calendar.auth_error` already existed and already published;
  // this is its first in-app entry (no rule existed either — see `engine/rules.ts`). Recipient
  // is the delivering expert. Straight into the calendar tab — the whole point of the nudge.
  //
  // BAL-414 (D10, addendum) — branches on `stillSearchable`, the SAME derived value the DB
  // de-list decision used (never recomputed here): a multi-provider expert whose other
  // connection is still ACTIVE stays searchable, so the body must not claim a search pause.
  'calendar-reconnect-required': (data) => {
    const providerLabel = calendarProviderLabel(data.provider);
    const body =
      data.stillSearchable === true
        ? `Balo lost access to your ${providerLabel} — busy time on it isn't being checked before a booking until it's reconnected. Your other connected calendar is still covering your search listing.`
        : // UX WARNING (fix round 1) — the email version already states the public-profile
          // pause (D1's other consequence); this in-app body previously omitted it, which is
          // exactly what made the RESTORE notice ("...public profile are live again") read as
          // referencing a pause this notice never disclosed.
          `Balo lost access to your ${providerLabel} — your availability is paused, you've stopped appearing in search, and your public profile link is on hold until it's reconnected.`;
    return {
      title: 'Reconnect your calendar',
      body,
      actionUrl: EXPERT_CALENDAR_SETTINGS_PATH,
    };
  },

  // BAL-414 (D1/D2) — the NON-calendar de-list. Recipient is the delivering expert. Straight
  // into settings — the whole point of the nudge.
  'expert-searchability-lost': (data) => {
    const count = arrayLength(data.failingItems);
    const suffix = count > 0 ? ` — ${pluralize(count, 'item')} left to finish` : '';
    return {
      title: "You've stopped appearing in search",
      // UX WARNING (fix round 1) — the email version already states the public-profile pause;
      // this in-app body previously omitted it entirely.
      body: `You've stopped appearing in Balo search and your public profile link is on hold. Finish setting up your profile to come back${suffix}.`,
      actionUrl: '/expert/settings',
    };
  },

  // BAL-414 (D2) — the re-list, IN-APP ONLY (no email rule). Both directions of cause: a
  // flapping calendar connection must never generate email churn, but the in-app confirmation
  // still fires every genuine transition.
  'expert-searchability-restored': () => ({
    title: "You're back in search",
    body: 'Your Balo search listing and public profile are live again.',
    actionUrl: '/expert/settings',
  }),

  // BAL-332 (D2) milestone completed — CLIENT owner ("your expert delivered").
  'engagement-milestone-completed-client': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'Your expert';
    const milestone = (data.milestoneTitle as string) ?? 'a milestone';
    const progress = milestoneProgress(data);
    const suffix = progress ? ` (${progress})` : '';
    return engagementNotice(
      'Milestone completed',
      `${actor} completed '${milestone}'${suffix}.`,
      data
    );
  },

  // BAL-332 (D2) milestone completed — ADMIN ops signal (project-scoped).
  'engagement-milestone-completed-admin': (data) => {
    const title = (data.projectTitle as string) ?? 'A project';
    const milestone = (data.milestoneTitle as string) ?? 'a milestone';
    const progress = milestoneProgress(data);
    const suffix = progress ? ` (${progress})` : '';
    return engagementNotice(
      'Milestone completed',
      `${title}: '${milestone}' completed${suffix}.`,
      data
    );
  },

  // BAL-332 (D2) milestone reverted — shared by the client-owner + admin rules.
  'engagement-milestone-reverted': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'Your expert';
    const milestone = (data.milestoneTitle as string) ?? 'a milestone';
    return engagementNotice(
      'Milestone reopened',
      `${actor} moved '${milestone}' back to in progress.`,
      data
    );
  },

  // BAL-333 (D3) delivery-plan scope changed — CLIENT owner (exact ticket copy).
  'engagement-scope-changed-client': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'Your expert';
    const summary = (data.changeSummary as string) ?? 'updated the delivery plan';
    return engagementNotice(
      'Delivery plan updated',
      `${actor} updated the delivery plan: ${summary}.`,
      data
    );
  },

  // BAL-333 (D3) delivery-plan scope changed — ADMIN ops signal (project-scoped, same summary).
  'engagement-scope-changed-admin': (data) => {
    const title = (data.projectTitle as string) ?? 'A project';
    const actor = (data.actorExpertLabel as string) ?? 'The expert';
    const summary = (data.changeSummary as string) ?? 'updated the delivery plan';
    return engagementNotice('Delivery plan updated', `${title}: ${actor} ${summary}.`, data);
  },

  // BAL-334 (D4) completion requested — CLIENT owner ("review it and make it official").
  'engagement-completion-requested-client': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'Your expert';
    const title = (data.projectTitle as string) ?? 'your project';
    const autoDate = (data.autoDate as string) ?? 'the review deadline';
    return engagementNotice(
      'Project complete — review it',
      `${actor} marked '${title}' complete 🎉 — take a look and make it official. Closes out as delivered on ${autoDate} if no one responds.`,
      data
    );
  },

  // BAL-334 (D4) completion requested — ADMIN ops signal (project-scoped, auto-accept date).
  'engagement-completion-requested-admin': (data) => {
    const title = (data.projectTitle as string) ?? 'A project';
    const company = (data.clientCompanyName as string) ?? 'the client';
    const autoDate = (data.autoDate as string) ?? 'the review deadline';
    return engagementNotice(
      'Sent for review',
      `${title} sent for ${company} review — auto-accepts ${autoDate}.`,
      data
    );
  },

  // BAL-334 (D4) completion withdrawn — shared by the client-owner + admin rules.
  'engagement-completion-withdrawn': (data) => {
    const actor = (data.actorExpertLabel as string) ?? 'The expert';
    const title = (data.projectTitle as string) ?? 'the project';
    return engagementNotice(
      'Back to active',
      `${actor} withdrew the completion request on ${title} — the project is active again.`,
      data
    );
  },

  // BAL-334 (D4) engagement cancelled — shared by the client-owner + expert rules.
  'engagement-cancelled': (data) => {
    const title = (data.projectTitle as string) ?? 'The project';
    const cancelledOn = (data.cancelledOn as string) ?? 'an earlier date';
    return engagementNotice(
      'Engagement cancelled',
      `${title} has been cancelled. Balo cancelled the engagement on ${cancelledOn}.`,
      data
    );
  },

  // BAL-338 (D7) client accepted — EXPERT (congrats). Retrospective person naming.
  'engagement-accepted-expert': (data) => {
    const actor = (data.actorClientLabel as string) ?? 'The client';
    const title = (data.projectTitle as string) ?? 'the project';
    return engagementNotice(
      'Project accepted 🎉',
      `${actor} accepted '${title}' — congratulations on the delivery. Balo takes care of the final invoice.`,
      data
    );
  },

  // BAL-338 (D7) client accepted — ADMIN (money signal).
  'engagement-accepted-admin': (data) => {
    const actor = (data.actorClientLabel as string) ?? 'The client';
    const title = (data.projectTitle as string) ?? 'A project';
    return engagementNotice(
      'Ready to invoice: final installment',
      `${actor} accepted '${title}' — final installment is ready to invoice.`,
      data
    );
  },

  // BAL-338 (D7) client requested changes — EXPERT (act).
  'engagement-changes-requested-expert': (data) => {
    const actor = (data.actorClientLabel as string) ?? 'The client';
    const title = (data.projectTitle as string) ?? 'the project';
    return engagementNotice(
      'Changes requested',
      `${actor} requested changes on '${title}' — the project is active again. Mark it complete when it's fixed.`,
      data
    );
  },

  // BAL-338 (D7) client requested changes — ADMIN ops signal (review cycle {n}).
  'engagement-changes-requested-admin': (data) => {
    const actor = (data.actorClientLabel as string) ?? 'The client';
    const title = (data.projectTitle as string) ?? 'A project';
    const cycle = typeof data.reviewCycle === 'number' ? data.reviewCycle : undefined;
    const cycleLabel = cycle ? ` (review cycle ${cycle})` : '';
    return engagementNotice(
      'Changes requested',
      `${actor} requested changes on '${title}'${cycleLabel}.`,
      data
    );
  },

  // BAL-338 (D7) auto-accepted — CLIENT (wrapped up as delivered).
  'engagement-auto-accepted-client': (data) => {
    const title = (data.projectTitle as string) ?? 'Your project';
    return engagementNotice(
      'Project complete 🎉',
      `'${title}' is complete — wrapped up as delivered after the review window. Balo will be in touch about the final invoice.`,
      data
    );
  },

  // BAL-338 (D7) auto-accepted — EXPERT (congrats).
  'engagement-auto-accepted-expert': (data) => {
    const title = (data.projectTitle as string) ?? 'The project';
    const autoDate = (data.autoDate as string) ?? 'the review deadline';
    return engagementNotice(
      'Project complete 🎉',
      `'${title}' closed out as delivered on ${autoDate} after the review window. Balo takes care of the final invoice.`,
      data
    );
  },

  // BAL-338 (D7) auto-accepted — ADMIN (money signal; auto path noted).
  'engagement-auto-accepted-admin': (data) => {
    const title = (data.projectTitle as string) ?? 'A project';
    const reviewDays = typeof data.reviewDays === 'number' ? data.reviewDays : 7;
    return engagementNotice(
      'Ready to invoice: final installment',
      `'${title}' accepted automatically (${reviewDays}-day window) — final installment is ready to invoice.`,
      data
    );
  },

  // BAL-338 (D7) T-2 review reminder — CLIENT (one friendly nudge).
  'engagement-review-reminder-client': (data) => {
    const title = (data.projectTitle as string) ?? 'Your project';
    const autoDate = (data.autoDate as string) ?? 'soon';
    return engagementNotice(
      'Your completed project is waiting 👋',
      `'${title}' wraps up as delivered on ${autoDate} — take a look and make it official.`,
      data
    );
  },

  // BAL-390 (D4) case closed — CLIENT. The in-app copy carries the RECORD only: the
  // star row and its magic-link token live in the email and nowhere else, so the bell
  // never has to render an ask it cannot satisfy. `closeReason` distinguishes a
  // deliberate resolve from a quiet-case close so the notice never reads as a
  // reprimand. Copy is DRAFT pending MJ sign-off.
  // ⚠ DELIBERATELY NOT `engagementNotice`, whose whole job is to build an engagements URL —
  // that route 404s for a CASE by construction (its loader filters engagement_type = project).
  // BAL-388's resolve action is this event FIRST publisher, so the deep link is the RECAP.
  // `?from=notification` keeps `recap_viewed.source` measurable. No `meetingId` ⇒ NO actionUrl.
  'engagement-case-closed-client': (data) => {
    const title = (data.caseTitle as string) ?? 'Your case';
    const closedDate = (data.closedDate as string) ?? 'today';
    const wentQuiet = data.closeReason === 'auto_inactive';
    const body = wentQuiet
      ? `'${title}' had been quiet for a while, so we closed it out on ${closedDate} rather than leave it hanging.`
      : `'${title}' is wrapped up as of ${closedDate}. Everything from it stays here whenever you need it.`;
    const meetingId = data.meetingId as string | undefined;
    return {
      title: 'Case closed',
      body,
      actionUrl: meetingId ? `/meetings/${meetingId}?from=notification` : undefined,
    };
  },

  // BAL-468 — the daily calendar-subscription monitor's non-zero-arm alert. Mirrors
  // `billing-details-confirmed-admin`'s shape: an ops signal for Balo staff, factual and
  // non-alarming. `actionUrl: undefined` — no admin surface exists for this yet (open
  // question in the BAL-468 plan). Every field degrades via `numberOrZero` so an absent count
  // renders `0`, never `NaN`/`undefined`.
  'calendar-subscription-lapse-admin': (data) => {
    const expiring = numberOrZero(data.expiringCount);
    const unconfirmed = numberOrZero(data.unconfirmedCount);
    const unsubscribed = numberOrZero(data.unsubscribedConnectionCount);
    // ⚠ ALL THREE ARMS, NOT TWO (PR #223 review). The monitor alerts on count > 0 in ANY arm,
    // so omitting `unconfirmedCount` meant an arm-2-only alert rendered "0 … and 0 …" — a
    // notification whose own numbers said nothing was wrong. The `log.error` paging signal
    // always carried all three; this brings the human-readable half into line with it.
    return {
      title: 'Calendar subscriptions need attention',
      body: `${expiring} calendar subscription(s) expire within 48 hours, ${unconfirmed} have never been confirmed by the calendar provider, and ${unsubscribed} connection(s) have none — the renewal sweep may be falling behind.`,
    };
  },

  // BAL-323: MJ's "ready to invoice" nudge once a company's billing details land.
  'billing-details-confirmed-admin': (data) => {
    const companyName = (data.companyName as string) ?? 'a company';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Billing details confirmed',
      body: `Billing details confirmed for ${companyName} — ready to invoice.`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'conversation-message-posted': (data) => {
    const senderName = (data.senderName as string) ?? 'Someone';
    const preview = (data.preview as string) ?? 'sent you a message';
    return {
      title: 'New message',
      body: `${senderName}: ${preview}`,
      actionUrl: conversationActionUrl(data),
    };
  },

  'conversation-file-shared': (data) => {
    const senderName = (data.senderName as string) ?? 'Someone';
    const fileName = (data.fileName as string) ?? 'a file';
    return {
      title: 'New file shared',
      body: `${senderName} shared ${fileName}`,
      actionUrl: conversationActionUrl(data),
    };
  },

  // BAL-324 admin billing reminder — OWNER (must add billing details).
  'project-billing-reminder-owner': (data) => {
    const title = (data.title as string) ?? 'your project';
    return projectRequestNotice(
      'Complete your billing details',
      `Add your billing details to kick off "${title}"`,
      data
    );
  },

  // BAL-324 admin billing reminder — CREATOR (FYI, no action of their own).
  'project-billing-reminder-creator': (data) => {
    const title = (data.title as string) ?? 'your project';
    return projectRequestNotice(
      'Billing details still needed',
      `"${title}" is on hold until your company's billing details are added`,
      data
    );
  },

  // BAL-380 (ADR-1040 Lane 3) dormancy reminder — company billing admins. Switches on
  // the merged-payload `window` (60|30). Warm, non-countdown: "still here", the date as
  // a plain fact, and a note that any activity keeps it going. Deep-links to expert search.
  'credit-dormancy-reminder': (data) => {
    const balance = formatAudMinor(numberOrZero(data.balanceMinor));
    const shortDate = formatExpiryDateShort((data.expiresAt as string) ?? '');
    if (data.window === 30) {
      return {
        title: `Your balance stays available until ${shortDate}`,
        body: `${balance} is still here. A good time to put it to use.`,
        actionUrl: '/experts',
      };
    }
    return {
      title: 'Your balance is still here',
      body: `${balance}, available until ${shortDate}. Any activity keeps it going.`,
      actionUrl: '/experts',
    };
  },

  // BAL-380 (ADR-1040 Lane 3) balance expired — company billing admins. Soft-toned,
  // provisional, no balance figure (0 post-expiry). Deep-links to the wallet/billing
  // panel (delivered by a later credit-system lane).
  'credit-balance-expired': () => ({
    title: 'About your balance',
    body: 'Your balance reached its expiry date. Add credit to pick back up anytime.',
    actionUrl: '/settings/billing',
  }),

  // BAL-379 (ADR-1040) auto-top-up executed — company billing admins. Warm, factual: the balance
  // ran low and was topped up on the saved card. AUD face value only (NO fee/overdraft). Billing.
  'credit-auto-topup-executed': (data) => {
    const reloaded = formatAudMinor(numberOrZero(data.reloadedMinor));
    const balanceAfter = formatAudMinor(numberOrZero(data.balanceAfterMinor));
    return {
      title: 'Auto-top-up complete',
      body: `We added ${reloaded} to keep things moving — your balance is now ${balanceAfter}.`,
      actionUrl: '/settings/billing',
    };
  },

  // BAL-379 (ADR-1040) auto-top-up failed — company billing admins. Calm, non-dunning (nothing
  // owed, nothing on hold). `reason` switches SCA vs hard-decline copy. AUD face value only.
  'credit-auto-topup-failed': (data) => {
    const attempted = formatAudMinor(numberOrZero(data.attemptedMinor));
    if (data.reason === 'requires_action') {
      return {
        title: 'Confirm your card to keep auto-top-up on',
        body: `Adding ${attempted} automatically needs a quick confirmation on your card — nothing's on hold.`,
        actionUrl: '/settings/billing',
      };
    }
    return {
      title: 'A quick card update keeps auto-top-up on',
      body: `We couldn't add ${attempted} automatically — nothing's owed or on hold; a card update keeps it going.`,
      actionUrl: '/settings/billing',
    };
  },

  // BAL-378 (ADR-1040 Lane 2) in-session drawdown / settlement in-app notices. Warm,
  // non-countdown; "extra time" is the client name for what was drawn past the balance — the
  // word "overdraft" NEVER appears. Money via `formatAudMinor` (no inline formatting).

  // Low balance — the in-session member (self).
  'session-low-balance': (data) => ({
    title: 'Balance running low',
    body: `About ${numberOrZero(data.minutesRemaining)} minutes of balance left — top up so nothing interrupts you.`,
    actionUrl: '/settings/billing',
  }),

  // Entered grace — the in-session member (self). Lens-neutral (self may be client or member).
  'session-grace-entered': () => ({
    title: "We're keeping you going",
    body: "You've used your balance — no interruption. Extra time from here settles afterward.",
    actionUrl: '/settings/billing',
  }),

  // Entered grace — the billing admins' async ping.
  'session-grace-entered-admin': () => ({
    title: 'A session is running on grace',
    body: "A teammate's session continued past the balance — the extra time will settle to your card.",
    actionUrl: '/settings/billing',
  }),

  // Nearing the wrap — the in-session member (self).
  'session-near-wrap': (data) => ({
    title: 'Coming up on a good place to wrap',
    body: `About ${numberOrZero(data.graceRemainingMinutes)} more minutes before we pause to settle up.`,
    actionUrl: '/settings/billing',
  }),

  // Settled receipt — billing admins.
  'session-settled': (data) => {
    const overdraft = numberOrZero(data.overdraftSettledMinor);
    const expertName = (data.expertName as string) ?? 'your expert';
    if (overdraft > 0) {
      return {
        title: 'Extra time settled',
        body: `We settled ${formatAudMinor(overdraft)} of extra time from your session with ${expertName} to your card.`,
        actionUrl: '/settings/billing',
      };
    }
    return {
      title: 'Session wrapped up',
      body: `Your session with ${expertName} stayed within your balance — nothing extra to settle.`,
      actionUrl: '/settings/billing',
    };
  },

  // Settlement failed — billing admins (dunning).
  'session-settlement-failed': (data) => {
    const amount = formatAudMinor(numberOrZero(data.amountMinor));
    if (data.reason === 'requires_action') {
      return {
        title: 'Confirm your card to finish up',
        body: `Settling ${amount} of extra time from a recent session needs a quick confirmation on your card.`,
        actionUrl: '/settings/billing',
      };
    }
    return {
      title: "Let's sort the extra time",
      body: `We couldn't settle ${amount} of extra time from a recent session — a quick card update sorts it.`,
      actionUrl: '/settings/billing',
    };
  },

  // Member top-up nudge — billing admins.
  'session-topup-nudge': (data) => {
    const requestedByName = (data.requestedByName as string) ?? 'A teammate';
    return {
      title: `${requestedByName} asked for a top-up`,
      body: `${requestedByName} is in a session and asked you to top up the team balance.`,
      actionUrl: '/settings/billing',
    };
  },

  // BAL-377 (ADR-1040 Lane 1) top-up receipt — the purchaser. Warm + factual: the credit
  // landed and the balance is ready. Mentions a promo bonus when one was granted. NO fee
  // figure (BAL-357). Deep-links to expert search (put the balance to use).
  'credit-topup-completed': (data) => {
    const balanceAfter = formatAudMinor(numberOrZero(data.balanceAfterMinor));
    const promoGrantedMinor = numberOrZero(data.promoGrantedMinor);
    const promoSuffix =
      promoGrantedMinor > 0 ? ` (including ${formatAudMinor(promoGrantedMinor)} bonus)` : '';
    return {
      title: "You're topped up",
      body: `Your balance is now ${balanceAfter}${promoSuffix}, ready when you are.`,
      actionUrl: '/experts',
    };
  },

  // BAL-377 / BAL-381 top-up nudge — company billing admins. Names the nudging member
  // (data.requesterName, hydrated by the resolver). Deep-links to the top-up composer.
  'credit-topup-requested': (data) => {
    const memberName = (data.requesterName as string) ?? 'A teammate';
    return {
      title: 'Top-up requested',
      body: `${memberName} asked you to top up your team's balance.`,
      actionUrl: '/billing/top-up',
    };
  },

  // BAL-521 §3 saved card removed — company billing admins, from EITHER door. Copy comes from
  // the ONE shared derivation (`buildSavedCardDetachedCopy`, F3) the email factory in `index.ts`
  // also calls, so the two channels cannot drift. Deep-links to billing settings (NOT
  // `/billing/top-up` — that route resolves to nothing for this destination).
  'credit-saved-card-detached': (data) => {
    const copy = buildSavedCardDetachedCopy(data);
    return {
      title: copy.headline,
      body: `${copy.leadSentence} ${copy.consequence}`,
      actionUrl: '/settings/billing',
    };
  },

  // BAL-522 — an explicit billing-email change, company billing admins (includes the actor, as
  // confirmation). Copy comes from the ONE shared derivation (`buildBillingEmailChangedCopy`)
  // the email factory in `index.ts` also calls. NO entry for `billing-email-changed-previous` —
  // that rule is email-only (no in-app surface for a possibly-non-user recipient).
  'billing-email-changed': (data) => {
    const copy = buildBillingEmailChangedCopy(data);
    const replaces = copy.previousEmail === null ? '' : ` It replaces ${copy.previousEmail}.`;
    return {
      title: 'Billing email updated',
      body: `${copy.label} set ${copy.companyName}'s billing email to ${copy.newEmail}.${replaces}`,
      actionUrl: '/settings/billing',
    };
  },

  // BAL-383 (ADR-1040) promo redeemed — the ACTOR who redeemed (recipient 'self'). Warm,
  // congratulatory, no countdown. `grantedLabel` / `companyName` come from the payload;
  // deep-links to expert search (the natural next step once credit lands).
  'promo-redeemed': (data) => {
    const grantedLabel = (data.grantedLabel as string) ?? 'Your credit';
    const companyName = (data.companyName as string) ?? 'your team';
    return {
      title: 'Credit added 🎉',
      body: `${grantedLabel} is ready for ${companyName} — find an expert whenever you are.`,
      actionUrl: '/experts',
    };
  },

  // BAL-399 (ADR-1040 / ADR-1043) payment charged — the acting MEMBER's consultation receipt
  // (recipient 'self'). The all-in charge ONLY; NO expert figure / margin. Deep-links to billing.
  //
  // BAL-412 (F16): ONE extra clause on a `no_show_client` settlement — see
  // `noShowClientClause`. Every other settlement renders exactly as it did before.
  'payment-charged': (data) => {
    const amount = formatAudMinor(numberOrZero(data.amountAudMinor));
    const expertName = (data.expertName as string) ?? 'your expert';
    return {
      title: 'Session receipt',
      body: `Your session with ${expertName} came to ${amount}.${noShowClientClause(data, 'client', expertName)}`,
      actionUrl: '/settings/billing',
    };
  },

  // BAL-399 (ADR-1040 / ADR-1043) payout recorded — the delivering EXPERT's own-earnings notice
  // (recipient 'expert'). Own earnings ONLY; NO client charge / markup / margin. Links to earnings.
  //
  // BAL-412 (F16): the AC's expert-side no-show "accrual confirmation" — in-app, factual, and
  // never a judgement about the client side.
  'payout-recorded': (data) => {
    const amount = formatAudMinor(numberOrZero(data.amountAudMinor));
    return {
      title: 'Earnings recorded',
      body: `${amount} from your recent session is recorded and on its way.${noShowClientClause(data, 'expert')}`,
      actionUrl: '/settings/earnings',
    };
  },

  // BAL-412 (ADR-1044 §7) missed call — the acting MEMBER (recipient 'self'). APOLOGETIC
  // register: Balo failed to connect them, nothing was charged, the hold is back in their
  // balance. Carries NO figure (nothing was charged) — nothing to conceal.
  'session-missed-call-client': (data) => {
    const expertName = (data.expertName as string) ?? 'your expert';
    return {
      title: "We're sorry — your session didn't connect",
      body: `${expertName} wasn't able to join. Nothing has been charged, and the funds we set aside are back in your balance.`,
      actionUrl: '/settings/billing',
    };
  },

  // BAL-412 (ADR-1044 §7) missed call — the delivering EXPERT (recipient 'expert'). FACTUAL,
  // NEVER PUNITIVE (D2/D8): no penalty in v1, but they should know it was recorded.
  'session-missed-call-expert': () => ({
    title: 'A consultation was recorded as a missed call',
    body: 'No payment applies for this one. If something went wrong on your end, let us know.',
    actionUrl: '/settings/earnings',
  }),

  // BAL-391 (ADR-1043) action item assigned — the assigned side (client owner OR expert).
  // One template serves both. Gender-neutral; `actorLabel` is the retrospective person;
  // the due date reads as a helpful fact (never a countdown). Deep-links to the workspace.
  'action-item-assigned': (data) => {
    const actor = (data.actorLabel as string) ?? 'A teammate';
    const body = (data.actionItemBody as string) ?? 'an action item';
    const dueOn = data.dueOn as string | undefined;
    const dueSuffix = dueOn ? ` · noted for ${dueOn}` : '';
    return engagementNotice(
      'New action item',
      `${actor} assigned you '${body}'${dueSuffix}.`,
      data
    );
  },

  // BAL-387 (ADR-1013 + ADR-1043) transcript recap ready — the client owner OR the delivering
  // expert. One template serves both. Carries no money (fee-safe); the headline (when present)
  // + action-item count read as helpful facts.
  //
  // ⚠ BAL-388 RE-POINTED THE DEEP LINK to the MEETING RECAP `/meetings/{meetingId}` — this
  // notification IS the recap's primary entry point, and `meetingId` has been REQUIRED on
  // `RecapReadyPayload` since BAL-418. It deliberately does NOT use `engagementNotice`, whose
  // whole job is to build an `/engagements/{id}` URL.
  'recap-ready': (data) => {
    const count = numberOrZero(data.actionItemCount);
    const headline = (data.summaryHeadline as string) ?? '';
    const plural = count === 1 ? '' : 's';
    const countSuffix = count > 0 ? ` · ${count} action item${plural}` : '';
    const body =
      headline.length > 0
        ? `${headline}${countSuffix}`
        : `Your session summary is ready${countSuffix}.`;
    const meetingId = data.meetingId as string | undefined;
    return {
      title: 'Session recap ready',
      body,
      // `?from=notification` is what makes `recap_viewed.source` readable for the recap's
      // PRIMARY entry point — the recap page whitelists exactly this value.
      actionUrl: meetingId ? `/meetings/${meetingId}?from=notification` : undefined,
    };
  },

  /**
   * BAL-408 — a guest joined YOUR side of a meeting. A low-signal roster FYI, fanned out
   * over the publisher-resolved `recipientUserIds` (in-app only; an email per added
   * colleague would be noise).
   *
   * ⚠ THIS ENTRY IS LOAD-BEARING IN A WAY A MISSING EMAIL TEMPLATE IS NOT. `getInAppTemplate`
   * does NOT throw on an unknown name — it silently returns the generic
   * "You have a new notification". So an absent template here degrades to a meaningless
   * notification with a green CI, which is why `in-app-templates.test.ts` asserts the REAL
   * title and body rather than merely that something rendered.
   *
   * ⚠ NAME ONLY, NEVER AN EMAIL ADDRESS — `guestDisplayName` is already name-only by payload
   * contract, and the fallback is the neutral "Someone", never an address or a local part.
   *
   * NO `actionUrl`: there is no meeting surface to deep-link to yet (BAL-421 / BAL-132 own
   * it), and a link to nowhere is worse than none.
   */
  'meeting-guest-added': (data) => {
    const guest = (data.guestDisplayName as string) ?? 'Someone';
    const title = (data.meetingTitle as string) ?? 'your consultation';
    return {
      title: 'Someone new is joining',
      body: `${guest} was added to ${title}.`,
    };
  },

  /**
   * BAL-134 — the expert is in the room and nobody from the client side has arrived.
   *
   * ⚠ THIS ENTRY IS LOAD-BEARING IN A WAY A MISSING EMAIL TEMPLATE IS NOT. `getInAppTemplate`
   * does NOT throw on an unknown name — it silently returns the generic "You have a new
   * notification". An absent entry therefore degrades to a MEANINGLESS in-app nudge with a
   * green CI, which is why `in-app-templates.test.ts` asserts the real title and body.
   *
   * ⚠ NO BILLING LINE AND NO COUNTDOWN. Nothing is charged until both sides are present, so a
   * charge claim would be false; a "you will be charged" line would be a threat aimed at
   * somebody a few minutes late. A quiet fact, and a way in.
   *
   * ⚠ PROSPECTIVE COPY NAMES THE **PARTY** (the expert's agency, or an independent expert's own
   * name), never an invented individual and never a pronoun. Absent ⇒ "Your expert".
   */
  'meeting-client-absent': (data) => {
    const waiting = data.waitingPartyName;
    const who = typeof waiting === 'string' && waiting.length > 0 ? waiting : 'Your expert';
    const meetingId = data.meetingId as string | undefined;
    return {
      title: 'Your consultation has started',
      body: `${who} is in the room and ready when you are.`,
      // ⚠ STRAIGHT INTO THE CALL — the whole point of the nudge is one tap to the room.
      ...(meetingId === undefined ? {} : { actionUrl: `/meetings/${meetingId}/call` }),
    };
  },
};

export function getInAppTemplate(templateName: string, data: Record<string, unknown>): InAppOutput {
  const factory = templates[templateName];
  if (!factory) {
    return { title: 'Notification', body: 'You have a new notification' };
  }
  return factory(data);
}
