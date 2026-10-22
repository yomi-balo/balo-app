import type { ClientMoveDetail } from '@balo/db';
import type { ExpertCounterpartyNameFields } from '@/lib/meetings/expert-counterparty';
import { formatPostedRelative } from '@/lib/project-request/request-detail-view';
import {
  proposalAwaitsClientReview,
  type ClientMoveKind,
  type PortfolioRowView,
} from '@/lib/projects-inbox/portfolio-row';
import {
  actionItemCards,
  cut,
  messageCards,
  partyLabels,
  sortYourMoveCards,
  type YourMoveActionItem,
  type YourMoveMessageThread,
  type YourMoveParty,
} from './build-your-move-cards';
import {
  YOUR_MOVE_ACTION_REPLY,
  YOUR_MOVE_ACTION_VIEW_KICKOFF,
  YOUR_MOVE_BALO,
  YOUR_MOVE_BILLING_BODY,
  YOUR_MOVE_BILLING_COUNTERPARTY,
  YOUR_MOVE_BILLING_TITLE,
  YOUR_MOVE_CLIENT_GATE_LABELS,
  YOUR_MOVE_EXPLORATORY_BODY,
  YOUR_MOVE_KICKOFF_MEMBER_BILLING_LABEL,
  YOUR_MOVE_KICKOFF_MEMBER_NOTE,
  YOUR_MOVE_STAT_LABELS,
  yourMoveAboutWeeks,
  yourMoveAcceptedFact,
  yourMoveAskedFact,
  yourMoveCompaniesSentence,
  yourMoveExpertCounterparty,
  yourMoveJoinTitle,
  yourMoveRelFact,
  yourMoveReviewProposalsAction,
  yourMoveSentFact,
  yourMoveSinceFact,
} from './your-move-copy';
import {
  YOUR_MOVE_KIND_META,
  type YourMoveCardView,
  type YourMoveContext,
} from './your-move-view-types';

/** People shown inline on the Team card; the rest collapse into `more`. */
const PEOPLE_SHOWN = 2;
const SNIPPET_MAX_CHARS = 140;
const UNNAMED_EXPERT = 'An expert';

export interface ClientRescheduleInput {
  readonly proposalId: string;
  readonly engagementId: string;
  readonly caseTitle: string;
  readonly expertProfileId: string;
  readonly originalScheduledStart: Date;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly optionStarts: readonly Date[];
}

export interface BuildClientMoveCardsInput {
  readonly rows: readonly PortfolioRowView[];
  readonly details: ReadonlyMap<string, ClientMoveDetail>;
  readonly expertNames: ReadonlyMap<string, ExpertCounterpartyNameFields>;
  readonly canManageBilling: boolean;
  readonly billingHoldSince: Date | null;
  readonly reschedules: readonly ClientRescheduleInput[];
  readonly joinRequests: readonly { name: string; email: string; createdAt: Date }[];
  readonly companyName: string;
  readonly actionItems: readonly YourMoveActionItem[];
  readonly messages: readonly YourMoveMessageThread[];
  readonly now: Date;
}

/** What a project card's kind-specific builder decides; the rest comes from the row. */
interface ProjectCardParts {
  readonly counterparty: string;
  readonly fact: string | null;
  readonly factAt?: YourMoveCardView['factAt'];
  readonly waitingSince?: string;
  readonly context: YourMoveContext | null;
  readonly actionLabel?: string;
}

interface ProjectInput {
  readonly row: PortfolioRowView;
  readonly detail: ClientMoveDetail | undefined;
  readonly input: BuildClientMoveCardsInput;
}

type DetailRelationship = ClientMoveDetail['relationships'][number];

function expertLabel(
  expertProfileId: string | null,
  expertNames: ReadonlyMap<string, ExpertCounterpartyNameFields>
): { readonly person: string; readonly full: string } {
  const party: YourMoveParty = { kind: 'expert', expertProfileId };
  const { name, org } = partyLabels(party, expertNames);
  return { person: name, full: yourMoveExpertCounterparty({ personName: name, agencyLabel: org }) };
}

function relationshipsAt(
  detail: ClientMoveDetail | undefined,
  status: DetailRelationship['status']
): DetailRelationship[] {
  return (detail?.relationships ?? []).filter((r) => r.status === status);
}

function exploratoryParts({ row }: ProjectInput): ProjectCardParts {
  return {
    counterparty: YOUR_MOVE_BALO,
    fact: yourMoveAskedFact(row.updatedRelative),
    context: { type: 'sentence', body: YOUR_MOVE_EXPLORATORY_BODY },
  };
}

function eoiCounterparty(
  signalExpert: DetailRelationship | undefined,
  submitted: readonly DetailRelationship[],
  expertNames: ReadonlyMap<string, ExpertCounterpartyNameFields>
): string {
  if (signalExpert !== undefined)
    return expertLabel(signalExpert.expertProfileId, expertNames).full;
  const [only, ...others] = submitted;
  if (only === undefined) return UNNAMED_EXPERT;
  if (others.length === 0) return expertLabel(only.expertProfileId, expertNames).full;
  return yourMoveCompaniesSentence(
    submitted.map((r) => expertLabel(r.expertProfileId, expertNames).person)
  );
}

function eoiReplyParts({ row, detail, input }: ProjectInput): ProjectCardParts {
  const { expertNames } = input;
  const signalRelationshipId = row.signal?.relationshipId;
  const signalExpert =
    signalRelationshipId === undefined
      ? undefined
      : (detail?.relationships ?? []).find((r) => r.relationshipId === signalRelationshipId);
  const preview = row.signal?.messagePreview;
  const context: YourMoveContext | null =
    preview === undefined || preview === ''
      ? null
      : {
          type: 'message',
          from: row.signal?.from ?? UNNAMED_EXPERT,
          at: null,
          snippet: cut(preview, SNIPPET_MAX_CHARS),
        };
  return {
    counterparty: eoiCounterparty(
      signalExpert,
      relationshipsAt(detail, 'eoi_submitted'),
      expertNames
    ),
    fact: yourMoveRelFact(row.updatedRelative),
    context,
    actionLabel: YOUR_MOVE_ACTION_REPLY,
  };
}

function proposalStats(
  proposal: NonNullable<DetailRelationship['currentProposal']>
): YourMoveContext {
  return {
    type: 'stats',
    stats: [
      { label: YOUR_MOVE_STAT_LABELS.version, value: String(proposal.version) },
      ...(proposal.timeframeWeeks === null
        ? []
        : [
            {
              label: YOUR_MOVE_STAT_LABELS.timeframe,
              value: yourMoveAboutWeeks(proposal.timeframeWeeks),
            },
          ]),
      { label: YOUR_MOVE_STAT_LABELS.milestones, value: String(proposal.milestoneCount) },
    ],
  };
}

function proposalReviewParts({ row, detail, input }: ProjectInput): ProjectCardParts {
  const { expertNames, now } = input;
  const awaiting = (detail?.relationships ?? []).filter((r) =>
    proposalAwaitsClientReview(r.status, r.currentProposal?.status ?? null)
  );
  const submittedTimes = awaiting.flatMap((r) =>
    r.currentProposal === null ? [] : [r.currentProposal.submittedAt.getTime()]
  );
  const fact = yourMoveSentFact(
    submittedTimes.length === 0
      ? row.updatedRelative
      : formatPostedRelative(new Date(Math.max(...submittedTimes)), now)
  );
  const waitingSince =
    submittedTimes.length === 0 ? undefined : new Date(Math.min(...submittedTimes)).toISOString();

  const [only, ...others] = awaiting;
  if (only === undefined) {
    return { counterparty: UNNAMED_EXPERT, fact, waitingSince, context: null };
  }
  if (others.length > 0) {
    return {
      counterparty: yourMoveCompaniesSentence(
        awaiting.map((r) => expertLabel(r.expertProfileId, expertNames).person)
      ),
      fact,
      waitingSince,
      context: null,
      actionLabel: yourMoveReviewProposalsAction(awaiting.length),
    };
  }
  return {
    counterparty: expertLabel(only.expertProfileId, expertNames).full,
    fact,
    waitingSince,
    context: only.currentProposal === null ? null : proposalStats(only.currentProposal),
  };
}

/**
 * The kickoff card's gates. Before Balo raises the upfront invoice the client owes billing,
 * and whether an invoice step follows depends on the proposal (not loaded here), so the rest
 * reads as one "Balo kickoff" gate. Once the invoice is raised the client owes payment.
 */
function kickoffContext(detail: ClientMoveDetail, canManageBilling: boolean): YourMoveContext {
  if (detail.upfrontInvoiceRaisedAt !== null) {
    return {
      type: 'gates',
      gates: [
        { label: YOUR_MOVE_CLIENT_GATE_LABELS.billing, state: 'done' },
        { label: YOUR_MOVE_CLIENT_GATE_LABELS.invoice, state: 'done' },
        {
          label: YOUR_MOVE_CLIENT_GATE_LABELS.payment,
          state: canManageBilling ? 'yours' : 'pending',
        },
      ],
      note: null,
    };
  }
  return {
    type: 'gates',
    gates: [
      canManageBilling
        ? { label: YOUR_MOVE_CLIENT_GATE_LABELS.billing, state: 'yours' }
        : { label: YOUR_MOVE_KICKOFF_MEMBER_BILLING_LABEL, state: 'pending' },
      { label: YOUR_MOVE_CLIENT_GATE_LABELS.kickoff, state: 'pending' },
    ],
    note: canManageBilling ? null : YOUR_MOVE_KICKOFF_MEMBER_NOTE,
  };
}

function kickoffParts({ row, detail, input }: ProjectInput): ProjectCardParts {
  const [accepted] = relationshipsAt(detail, 'accepted');
  return {
    counterparty:
      accepted === undefined
        ? UNNAMED_EXPERT
        : expertLabel(accepted.expertProfileId, input.expertNames).full,
    fact: yourMoveAcceptedFact(row.updatedRelative),
    context: detail === undefined ? null : kickoffContext(detail, input.canManageBilling),
    actionLabel: input.canManageBilling ? undefined : YOUR_MOVE_ACTION_VIEW_KICKOFF,
  };
}

function completionParts({ row, input }: ProjectInput): ProjectCardParts {
  const counterparty = expertLabel(row.expertProfileId ?? null, input.expertNames).full;
  const { completion } = row;
  if (completion === null || completion === undefined) {
    return { counterparty, fact: null, context: null };
  }
  return {
    counterparty,
    fact: null,
    factAt: { template: 'marked_complete', iso: completion.completionRequestedAtIso },
    waitingSince: completion.completionRequestedAtIso,
    context: {
      type: 'completion',
      done: completion.milestonesDone,
      total: completion.milestonesTotal,
      autoAcceptIso: completion.autoAcceptAtIso,
    },
  };
}

const PROJECT_PARTS: Record<ClientMoveKind, (input: ProjectInput) => ProjectCardParts> = {
  exploratory_call: exploratoryParts,
  eoi_reply: eoiReplyParts,
  proposal_review: proposalReviewParts,
  kickoff_billing: kickoffParts,
  kickoff_payment: kickoffParts,
  completion: completionParts,
};

function projectCards(input: BuildClientMoveCardsInput): YourMoveCardView[] {
  const cards: YourMoveCardView[] = [];
  for (const row of input.rows) {
    const { clientMoveKind } = row;
    if (!row.needsYou || clientMoveKind === null || clientMoveKind === undefined) continue;
    const parts = PROJECT_PARTS[clientMoveKind]({
      row,
      detail: input.details.get(row.id),
      input,
    });
    cards.push({
      id: row.id,
      kind: clientMoveKind,
      title: row.title,
      counterparty: parts.counterparty,
      fact: parts.fact,
      factAt: parts.factAt ?? null,
      factTone: 'muted',
      actionLabel: parts.actionLabel ?? YOUR_MOVE_KIND_META[clientMoveKind].action,
      href: row.href ?? '/projects',
      waitingSince: parts.waitingSince ?? row.recencyAtIso,
      deadline: null,
      context: parts.context,
    });
  }
  return cards;
}

function billingCards(holdSince: Date | null): YourMoveCardView[] {
  if (holdSince === null) return [];
  const iso = holdSince.toISOString();
  return [
    {
      id: 'receivable',
      kind: 'receivable',
      title: YOUR_MOVE_BILLING_TITLE,
      counterparty: YOUR_MOVE_BILLING_COUNTERPARTY,
      fact: null,
      factAt: { template: 'since', iso },
      factTone: 'muted',
      actionLabel: YOUR_MOVE_KIND_META.receivable.action,
      href: '/settings/billing',
      waitingSince: iso,
      deadline: null,
      context: { type: 'sentence', body: YOUR_MOVE_BILLING_BODY },
    },
  ];
}

function rescheduleCards(input: BuildClientMoveCardsInput): YourMoveCardView[] {
  return input.reschedules.map((proposal) => {
    const expiresIso = proposal.expiresAt.toISOString();
    return {
      id: `reschedule-${proposal.proposalId}`,
      kind: 'reschedule',
      title: proposal.caseTitle,
      counterparty: expertLabel(proposal.expertProfileId, input.expertNames).full,
      fact: null,
      factAt: { template: 'reply_by', iso: expiresIso },
      factTone: 'warning',
      actionLabel: YOUR_MOVE_KIND_META.reschedule.action,
      href: `/cases/${proposal.engagementId}`,
      waitingSince: proposal.createdAt.toISOString(),
      deadline: expiresIso,
      context: {
        type: 'reschedule',
        wasIso: proposal.originalScheduledStart.toISOString(),
        optionIsos: proposal.optionStarts.map((start) => start.toISOString()),
      },
    };
  });
}

function teamCards(input: BuildClientMoveCardsInput): YourMoveCardView[] {
  const { joinRequests, now } = input;
  if (joinRequests.length === 0) return [];
  const oldest = new Date(Math.min(...joinRequests.map((r) => r.createdAt.getTime())));
  return [
    {
      id: 'join_requests',
      kind: 'join_requests',
      title: yourMoveJoinTitle(joinRequests.length),
      counterparty: input.companyName,
      fact: yourMoveSinceFact(formatPostedRelative(oldest, now)),
      factAt: null,
      factTone: 'muted',
      actionLabel: YOUR_MOVE_KIND_META.join_requests.action,
      href: '/settings/team',
      waitingSince: oldest.toISOString(),
      deadline: null,
      context: {
        type: 'people',
        people: joinRequests.slice(0, PEOPLE_SHOWN).map(({ name, email }) => ({ name, email })),
        more: Math.max(0, joinRequests.length - PEOPLE_SHOWN),
      },
    },
  ];
}

/** The company "Your move" rail: one card per needs-you project row plus the gated arms. */
export function buildClientYourMoveCards(input: BuildClientMoveCardsInput): YourMoveCardView[] {
  return sortYourMoveCards([
    ...billingCards(input.billingHoldSince),
    ...projectCards(input),
    ...rescheduleCards(input),
    ...teamCards(input),
    ...actionItemCards(input.actionItems, input.expertNames, input.now),
    ...messageCards(input.messages, input.expertNames, input.now, 'sender'),
  ]);
}
