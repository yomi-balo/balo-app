import 'server-only';

import { AUTO_ACCEPT_DAYS, type ProjectEngagementWithMilestones } from '@balo/db';
import { joinTitles } from '@balo/shared/engagements';
import { formatShortUtc } from '@/lib/format/utc-date';
import { personAtCompany, type EngagementParties } from './engagement-parties';
import type { EngagementLens } from './resolve-engagement-lens';
import type {
  ChangeRequestBannerView,
  MilestoneFeedbackView,
  ProgressSegmentView,
  ReviewBannerView,
  ReviewPillView,
} from './engagement-view';

/**
 * Change-request derivations for the delivery workspace. PURE — every surface (banner,
 * pill, progress segments, milestone feedback, the client's "last request" quote) reads the
 * LATEST durable round off the workspace graph (`latestChangeRequest`), never the legacy
 * `change_request_note` column, which `requestCompletion` nulls.
 *
 * Pricing-agnostic: Fixed and T&M render identically.
 */

type Milestone = ProjectEngagementWithMilestones['milestones'][number];
type LatestRound = NonNullable<ProjectEngagementWithMilestones['latestChangeRequest']>;

/** What the latest change request means for the project right now. Derived once per view. */
export interface ChangeRequestState {
  /** The most recent live round, or null when the client never requested changes. */
  latest: LatestRound | null;
  /**
   * The latest round is still unaccepted: the project is `active` with a round on record.
   * A withdrawn resubmission lands here too — the client's feedback is still outstanding.
   */
  outstanding: boolean;
  /** The latest round's tagged milestones that are still live, in plan order. */
  taggedLive: Milestone[];
  /** The tagged milestones that are not complete — the work the round reopened. */
  reopened: Milestone[];
  /**
   * Every tagged milestone is done again and so is the rest of the plan: the expert's
   * only step left is to send the project back. An untagged round never reaches this.
   */
  changesMade: boolean;
  /** "Dana @ Northwind Industrial" — retrospective first mention of the requester. */
  attribution: string;
  /** "Dana" — the requester's bare name once the banner has made the first mention. */
  requesterShort: string;
  /** "6 Jul". */
  dateLabel: string;
}

/** The bare first name (last name as fallback), or the company when the person is unknown. */
function personShort(
  person: { firstName: string | null; lastName: string | null } | null,
  companyName: string
): string {
  if (person === null) return companyName;
  return (person.firstName ?? '').trim() || (person.lastName ?? '').trim() || companyName;
}

/** The label on the control that sends a project back for review after a change request. */
export const MARK_READY_AGAIN_LABEL = 'Mark project ready again';

export function deriveChangeRequestState(
  engagement: ProjectEngagementWithMilestones,
  parties: EngagementParties
): ChangeRequestState {
  const latest = engagement.latestChangeRequest;
  const outstanding = engagement.status === 'active' && latest !== null;
  const taggedIds = new Set(latest?.taggedMilestoneIds ?? []);
  const taggedLive = engagement.milestones.filter((m) => taggedIds.has(m.id));
  const reopened = taggedLive.filter((m) => m.status !== 'completed');
  const allDone =
    engagement.milestones.length > 0 &&
    engagement.milestones.every((m) => m.status === 'completed');
  return {
    latest,
    outstanding,
    taggedLive,
    reopened,
    changesMade: outstanding && taggedLive.length > 0 && reopened.length === 0 && allDone,
    attribution:
      latest === null
        ? parties.clientCompanyName
        : personAtCompany(latest.requestedBy, parties.clientCompanyName),
    requesterShort:
      latest === null
        ? parties.clientCompanyName
        : personShort(latest.requestedBy, parties.clientCompanyName),
    dateLabel: latest === null ? '' : formatShortUtc(latest.requestedAt),
  };
}

/** The request-completion modal body: window + plan-lock + invoice copy. */
export function completionModalBody(total: number, client: string): string {
  let opening: string;
  if (total === 0) {
    opening =
      "This project has no milestones, so there's nothing blocking completion — but only send it if delivery is genuinely done. ";
  } else if (total === 1) {
    opening = 'The milestone is delivered. ';
  } else {
    opening = `All ${total} milestones are delivered. `;
  }
  return `${opening}${client} reviews the whole project and can accept it or request changes within ${AUTO_ACCEPT_DAYS} days — after that it's accepted automatically. The delivery plan is locked while the project is in review, and Balo raises the final invoice once accepted.`;
}

/** " on A and B" when milestones were tagged, else "". */
function onTagged(taggedLive: readonly Milestone[]): string {
  return taggedLive.length > 0 ? ` on ${joinTitles(taggedLive.map((m) => m.title))}` : '';
}

function expertGuidance(state: ChangeRequestState): string {
  const { reopened, taggedLive } = state;
  if (reopened.length > 0) {
    const are = reopened.length === 1 ? 'is' : 'are';
    const them = reopened.length === 1 ? 'it' : 'them';
    return `${joinTitles(reopened.map((m) => m.title))} ${are} back in progress. Complete ${them}, then mark the project ready again.`;
  }
  if (taggedLive.length > 0) {
    return 'Your changes are in. Finish the remaining milestones, then mark the project ready again.';
  }
  return 'No milestones were tagged, so reopen whatever needs work, then mark the project ready again.';
}

export function deriveChangeRequestBanner(
  engagement: ProjectEngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties,
  state: ChangeRequestState
): ChangeRequestBannerView | null {
  const { latest } = state;
  if (!state.outstanding || latest === null) return null;

  const tagged = onTagged(state.taggedLive);
  if (lens === 'client') {
    return {
      variant: 'client_waiting',
      body: `You requested changes${tagged}. ${parties.expertPartyShort} is working on them, and you'll be told when the project is ready again.`,
    };
  }
  if (lens === 'expert' && state.changesMade) {
    return {
      variant: 'changes_made',
      headline: `Changes made. Ready to send back to ${parties.clientCompanyName}?`,
      reminder: `${state.attribution} asked: “${latest.note}”`,
      ctaLabel: MARK_READY_AGAIN_LABEL,
      modalBody: completionModalBody(engagement.milestones.length, parties.clientCompanyName),
    };
  }
  return {
    variant: 'work_outstanding',
    headline: `${state.attribution} requested changes${tagged}.`,
    quote: latest.note,
    guidance: lens === 'expert' ? expertGuidance(state) : null,
  };
}

export function deriveReviewPill(
  engagement: ProjectEngagementWithMilestones,
  lens: EngagementLens,
  parties: EngagementParties,
  state: ChangeRequestState
): ReviewPillView | null {
  if (state.outstanding) return { label: 'Changes requested', tone: 'warning' };
  if (engagement.status === 'pending_acceptance') {
    return {
      label:
        lens === 'client' ? 'Ready for your review' : `Waiting on ${parties.clientCompanyName}`,
      tone: 'violet',
    };
  }
  if (engagement.status === 'completed') {
    return {
      label:
        engagement.acceptedAt === null
          ? 'Accepted'
          : `Accepted ${formatShortUtc(engagement.acceptedAt)}`,
      tone: 'success',
    };
  }
  return null;
}

const SEGMENT_TONE_BY_STATUS: Record<Milestone['status'], ProgressSegmentView['tone']> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
};

const SEGMENT_LABEL_BY_TONE: Record<ProgressSegmentView['tone'], string> = {
  completed: 'Completed',
  in_progress: 'In progress',
  pending: 'Not started',
  reopened: 'Changes requested',
};

export function deriveSegments(
  engagement: ProjectEngagementWithMilestones,
  state: ChangeRequestState
): ProgressSegmentView[] {
  const reopenedIds = new Set(state.outstanding ? state.reopened.map((m) => m.id) : []);
  return engagement.milestones.map((m) => {
    const tone = reopenedIds.has(m.id) ? 'reopened' : SEGMENT_TONE_BY_STATUS[m.status];
    return { id: m.id, tone, label: `${m.title}: ${SEGMENT_LABEL_BY_TONE[tone]}` };
  });
}

export function deriveMilestoneFeedback(
  engagement: ProjectEngagementWithMilestones,
  state: ChangeRequestState,
  milestoneId: string,
  lens: EngagementLens
): MilestoneFeedbackView | null {
  const { latest } = state;
  if (latest === null) return null;
  if (engagement.status !== 'active' && engagement.status !== 'pending_acceptance') return null;
  if (!latest.taggedMilestoneIds.includes(milestoneId)) return null;
  const isClient = lens === 'client';
  return {
    calloutHeading: isClient
      ? `Your feedback · ${state.dateLabel}`
      : `${state.requesterShort} requested changes · ${state.dateLabel}`,
    note: latest.note,
    addressedLabel: isClient ? 'Updated after your feedback' : 'Feedback addressed',
  };
}

/** The client's previous request, quoted on the next review banner. Null before any round. */
export function deriveLastRequest(
  engagement: ProjectEngagementWithMilestones
): ReviewBannerView['lastRequest'] {
  const { latestChangeRequest: latest } = engagement;
  if (latest === null) return null;
  return {
    heading: `Your last request · ${formatShortUtc(latest.requestedAt)}`,
    note: latest.note,
  };
}
