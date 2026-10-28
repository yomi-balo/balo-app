import 'server-only';

import { z } from 'zod';
import {
  companiesRepository,
  type ChangeOrderLineInput,
  type ChangeOrderRecord,
  type ProjectEngagementWithMilestones,
} from '@balo/db';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import type { EngagementParties } from '@/lib/engagement/engagement-parties';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import {
  CHANGE_ORDER_DENIED,
  NOT_ACTIVE,
  ONLY_CLIENT,
  ONLY_EXPERT,
  loadEngagementLens,
  wholeDaysSince,
  deriveEngagementTitle,
  type GateResult,
} from './engagement-lifecycle-shared';
import {
  INVALID_REQUEST,
  PLAN_CHANGED,
  descriptionTextToSafeHtml,
  gateExpertSideAct,
  type ExpertSideGateResult,
} from './milestone-action-shared';

export {
  CHANGE_ALREADY_OPEN,
  CHANGE_ORDER_PENDING,
  REASON_REQUIRED,
  coherenceMessage,
} from './engagement-lifecycle-shared';
export { MILESTONE_CHANGE_PENDING } from './milestone-action-shared';

type ClientChangeOrderCapability =
  | typeof CAPABILITIES.PARTICIPATE
  | typeof CAPABILITIES.APPROVE_OWN_PROPOSALS;

/**
 * The CLIENT-side gate for a change-order act: the actor holds `capability` on the
 * engagement's company (membership axis, read live), and the project is `active`. A stranger
 * and a missing row share one `NOT_FOUND`. Requesting uses `PARTICIPATE`; approving and
 * declining use `APPROVE_OWN_PROPOSALS`.
 */
export async function gateChangeOrderClient(
  user: SessionUser,
  engagementId: string,
  capability: ClientChangeOrderCapability
): Promise<GateResult> {
  const loaded = await loadEngagementLens(user, engagementId, CHANGE_ORDER_DENIED);
  if (!loaded.ok) {
    return loaded;
  }
  if (loaded.engagement.status !== 'active') {
    log.warn(CHANGE_ORDER_DENIED, { engagementId, userId: user.id, reason: 'wrong_status' });
    return { ok: false, error: NOT_ACTIVE };
  }
  const allowed = await hasCapability(user, capability, {
    companyId: loaded.engagement.companyId,
  });
  if (!allowed) {
    log.warn(CHANGE_ORDER_DENIED, { engagementId, userId: user.id, reason: 'no_capability' });
    return { ok: false, error: ONLY_CLIENT };
  }
  return { ok: true, engagement: loaded.engagement };
}

/**
 * The EXPERT-side gate for an act on an `active` project: the actor holds `manage_engagement`
 * on the engagement axis (the delivering expert, or an owner or admin of their agency). The
 * engagement is loaded directly rather than through the lens resolver, which would turn away
 * an agency owner who is not the delivering expert. A non-holder who is not a party at all
 * sees the same `NOT_FOUND` as a missing row. Every deny path logs `logMessage`, the act
 * family's own name.
 */
export async function gateActiveExpertSideAct(
  user: SessionUser,
  engagementId: string,
  logMessage: string
): Promise<ExpertSideGateResult> {
  const gate = await gateExpertSideAct(user, engagementId, {
    notHolder: ONLY_EXPERT,
    logMessage,
  });
  if (!gate.ok) {
    return gate;
  }
  if (gate.engagement.status !== 'active') {
    log.warn(logMessage, { engagementId, userId: user.id, reason: 'wrong_status' });
    return { ok: false, error: NOT_ACTIVE };
  }
  return gate;
}

/** The EXPERT-side gate for a change-order act: {@link gateActiveExpertSideAct}. */
export async function gateChangeOrderExpert(
  user: SessionUser,
  engagementId: string
): Promise<ExpertSideGateResult> {
  return gateActiveExpertSideAct(user, engagementId, CHANGE_ORDER_DENIED);
}

/**
 * What `saveChangeOrderAction` returns: the lifecycle result plus the id of the order it
 * saved, on success and on a failure that came after the save (a send that was refused), so a
 * retry reuses that order instead of opening another.
 */
export type SaveChangeOrderResult =
  | { success: true; changeOrderId?: string }
  | { success: false; error: string; changeOrderId?: string };

/**
 * The `requestedByUserId` payload key for an order that came from a client request: present
 * only when the requester is not the owner (who already gets the notice) and is still a live
 * member of the client company. A lookup failure leaves it out.
 */
export async function requesterPayload(
  requestedByUserId: string | null,
  ownerId: string | undefined,
  companyId: string
): Promise<{ requestedByUserId?: string }> {
  if (requestedByUserId === null || requestedByUserId === ownerId) return {};
  try {
    const company = await companiesRepository.findWithMembers(companyId);
    const isMember = company?.members.some((m) => m.userId === requestedByUserId) ?? false;
    return isMember ? { requestedByUserId } : {};
  } catch {
    return {};
  }
}

/** The most lines one change order may carry. */
export const MAX_CHANGE_ORDER_LINES = 100;

/** One milestone amendment as the composer submits it (plain text, minutes). */
export const lineDraftSchema = z
  .object({
    op: z.enum(['add', 'edit', 'remove']),
    milestoneId: z.uuid().optional(),
    title: z.string().trim().min(1).max(200),
    descriptionText: z.string().max(10_000).nullable().optional(),
    estimatedMinutes: z.number().int().min(1).max(100000).nullable().optional(),
  })
  .strict();

export type LineDraft = z.infer<typeof lineDraftSchema>;

export type LineInputsResult =
  | { ok: true; lines: ChangeOrderLineInput[] }
  | { ok: false; error: string };

/**
 * An edit line keeps the live (possibly rich) description when its plain text is unchanged,
 * so a title-only edit never flattens the milestone's formatting; changed text is rebuilt
 * through the project-HTML sanitiser.
 */
function editedDescriptionHtml(
  draft: LineDraft,
  live: ProjectEngagementWithMilestones['milestones'][number] | undefined
): string | null {
  if (live !== undefined) {
    const currentPlain = htmlToPlainText(live.descriptionHtml ?? '');
    if (currentPlain === (draft.descriptionText ?? '').trim()) return live.descriptionHtml;
  }
  return descriptionTextToSafeHtml(draft.descriptionText);
}

type LiveMilestone = ProjectEngagementWithMilestones['milestones'][number];

function lineDescriptionHtml(draft: LineDraft, live: LiveMilestone | undefined): string | null {
  if (draft.op === 'remove') return null;
  if (draft.op === 'edit') return editedDescriptionHtml(draft, live);
  return descriptionTextToSafeHtml(draft.descriptionText);
}

/** One draft as a repository line input, or the refusal message when its milestone id is wrong. */
function lineInputFor(
  draft: LineDraft,
  liveById: ReadonlyMap<string, LiveMilestone>
): { ok: true; line: ChangeOrderLineInput } | { ok: false; error: string } {
  const { op, milestoneId } = draft;
  if ((op === 'add') !== (milestoneId === undefined)) {
    return { ok: false, error: INVALID_REQUEST };
  }
  const live = milestoneId === undefined ? undefined : liveById.get(milestoneId);
  if (op !== 'add' && live === undefined) {
    return { ok: false, error: PLAN_CHANGED };
  }
  return {
    ok: true,
    line: {
      op,
      engagementMilestoneId: milestoneId ?? null,
      title: op === 'remove' ? (live?.title ?? draft.title) : draft.title,
      descriptionHtml: lineDescriptionHtml(draft, live),
      acceptanceCriteria: null,
      valueCents: null,
      estimatedMinutes: op === 'remove' ? null : (draft.estimatedMinutes ?? null),
    },
  };
}

/**
 * The repository's line inputs for the composer's drafts. An `add` names no milestone; an
 * `edit` or `remove` must name a live milestone of THIS engagement (an unknown id is
 * `PLAN_CHANGED`, before any write). A `remove` keeps the live title; descriptions pass
 * through the project-HTML sanitiser. Per-milestone values are never sent (`valueCents`
 * stays null): the composer edits the project total.
 */
export function toLineInputs(
  drafts: readonly LineDraft[],
  engagement: ProjectEngagementWithMilestones
): LineInputsResult {
  const liveById = new Map(engagement.milestones.map((m) => [m.id, m]));
  const lines: ChangeOrderLineInput[] = [];
  for (const draft of drafts) {
    const built = lineInputFor(draft, liveById);
    if (!built.ok) return built;
    lines.push(built.line);
  }
  return { ok: true, lines };
}

/**
 * The analytics properties every change-order event past `requested` carries. No amounts:
 * `has_price_change` records only whether the price moves.
 */
export function changeOrderLinesProps(
  order: ChangeOrderRecord,
  pricingMethod: string,
  userId: string
): {
  engagement_id: string;
  change_order_id: string;
  pricing_method: string;
  lines_added: number;
  lines_edited: number;
  lines_removed: number;
  has_price_change: boolean;
  initiated_by: 'client' | 'expert';
  distinct_id: string;
} {
  const count = (op: 'add' | 'edit' | 'remove'): number =>
    order.lines.filter((line) => line.op === op).length;
  return {
    engagement_id: order.engagementId,
    change_order_id: order.id,
    pricing_method: pricingMethod,
    lines_added: count('add'),
    lines_edited: count('edit'),
    lines_removed: count('remove'),
    has_price_change: (order.priceDeltaCents ?? 0) !== 0,
    initiated_by: order.requestedAt === null ? 'expert' : 'client',
    distinct_id: userId,
  };
}

/** Whole days from the send (or, for an answered request, the request) to `now`. */
export function daysToDecision(order: ChangeOrderRecord, now: Date): number {
  const from = order.sentAt ?? order.requestedAt ?? order.createdAt;
  return wholeDaysSince(from, now);
}

/** The fields every change-order notification payload shares. */
export function payloadBase(
  event: string,
  order: Pick<ChangeOrderRecord, 'id'>,
  engagement: ProjectEngagementWithMilestones,
  parties: EngagementParties
): {
  correlationId: string;
  engagementId: string;
  changeOrderId: string;
  projectTitle: string;
} {
  return {
    correlationId: `${order.id}:${event}`,
    engagementId: engagement.id,
    changeOrderId: order.id,
    projectTitle: deriveEngagementTitle(engagement, parties),
  };
}
