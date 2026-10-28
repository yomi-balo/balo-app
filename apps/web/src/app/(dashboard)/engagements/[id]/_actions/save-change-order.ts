'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  engagementChangeOrdersRepository,
  type ChangeOrderRecord,
  type ProjectEngagementWithMilestones,
} from '@balo/db';
import { changeOrderMinutesDelta, clientPriceChangeCents } from '@balo/shared/engagements';
import { applyBaloFee } from '@balo/shared/pricing';
import {
  effectiveExpertPriceCents,
  formatHours,
  signedHours,
  signedMoney,
} from '@/lib/engagement/change-order-view';
import { deriveEngagementParties, expertSideActorLabel } from '@/lib/engagement/engagement-parties';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { trackServerAndFlush, ENGAGEMENT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import {
  INVALID_REQUEST,
  STATUS_CHANGED,
  requireSignedInUser,
  resolveClientRecipientId,
  runEngagementLifecycleAction,
} from './engagement-lifecycle-shared';
import {
  CHANGE_ALREADY_OPEN,
  MAX_CHANGE_ORDER_LINES,
  changeOrderLinesProps,
  gateChangeOrderExpert,
  lineDraftSchema,
  payloadBase,
  requesterPayload,
  toLineInputs,
  type SaveChangeOrderResult,
} from './change-order-action-shared';

/** The largest total the integer price columns hold. */
const MAX_TOTAL_CENTS = 2_147_483_647;

const saveChangeOrderSchema = z
  .object({
    engagementId: z.uuid(),
    orderId: z.uuid().optional(),
    note: z.string().trim().max(2000),
    newTotalCents: z.number().int().min(0).max(MAX_TOTAL_CENTS).optional(),
    lines: z.array(lineDraftSchema).max(MAX_CHANGE_ORDER_LINES),
    send: z.boolean(),
  })
  .strict();

type SaveChangeOrderInput = z.input<typeof saveChangeOrderSchema>;

type DraftContent = Parameters<typeof engagementChangeOrdersRepository.createDraft>[0];
type PersistedDraft = { ok: true; saved: ChangeOrderRecord } | { ok: false; error: string };

/**
 * Write the draft against whatever order is open: none opens a fresh draft, a client
 * `requested` order becomes the draft, an open draft has its lines replaced. A mismatch
 * between the open order and the one the caller named is a refusal.
 */
async function persistDraft(
  open: ChangeOrderRecord | undefined,
  orderId: string | undefined,
  content: DraftContent
): Promise<PersistedDraft> {
  const repo = engagementChangeOrdersRepository;
  if (open === undefined) {
    if (orderId !== undefined) {
      return { ok: false, error: STATUS_CHANGED };
    }
    return { ok: true, saved: await repo.createDraft(content) };
  }
  if (open.id !== orderId) {
    return { ok: false, error: orderId === undefined ? CHANGE_ALREADY_OPEN : STATUS_CHANGED };
  }
  if (open.status === 'requested') {
    return { ok: true, saved: await repo.createDraft({ ...content, fromOrderId: open.id }) };
  }
  if (open.status === 'draft') {
    return { ok: true, saved: await repo.replaceLines({ ...content, orderId: open.id }) };
  }
  return { ok: false, error: STATUS_CHANGED };
}

/**
 * Tell the client owner a change is waiting. Money is the CLIENT's: the price label is the
 * grossed-up effective price before and after, never the expert figure.
 */
async function publishSent(
  engagement: ProjectEngagementWithMilestones,
  sent: ChangeOrderRecord,
  effectiveCents: number,
  actor: SessionUser
): Promise<void> {
  const parties = deriveEngagementParties(engagement);
  const { currency, baloFeeBps } = engagement;
  const isFixed = engagement.pricingMethod === 'fixed';
  const recipientId = await resolveClientRecipientId(engagement.company.id);
  const lineCount = (op: 'add' | 'edit' | 'remove'): number =>
    sent.lines.filter((line) => line.op === op).length;

  const capDeltaCents = sent.priceDeltaCents ?? 0;
  const toExpert = effectiveCents + capDeltaCents;
  const clientDelta = clientPriceChangeCents(effectiveCents, toExpert, baloFeeBps);
  let clientPriceChangeLabel: string | undefined;
  let estimateChangeLabel: string | undefined;
  if (isFixed) {
    clientPriceChangeLabel = `${formatWholeCurrency(applyBaloFee(effectiveCents, baloFeeBps), currency)} → ${formatWholeCurrency(applyBaloFee(toExpert, baloFeeBps), currency)} (${signedMoney(clientDelta, currency)})`;
  } else {
    if (capDeltaCents !== 0) {
      clientPriceChangeLabel = `Cap ${formatWholeCurrency(applyBaloFee(effectiveCents, baloFeeBps), currency)} → ${formatWholeCurrency(applyBaloFee(toExpert, baloFeeBps), currency)} (${signedMoney(clientDelta, currency)})`;
    }
    const before = engagement.milestones.reduce((sum, m) => sum + (m.estimatedMinutes ?? 0), 0);
    const delta = changeOrderMinutesDelta(sent.lines);
    estimateChangeLabel = `${formatHours(before)} → ${formatHours(before + delta)} (${signedHours(delta)})`;
  }

  publishNotificationEvent('change_order.sent', {
    ...payloadBase('sent', sent, engagement, parties),
    recipientId,
    actorExpertLabel: expertSideActorLabel(engagement, parties, actor),
    clientCompanyName: parties.clientCompanyName,
    summary: sent.note ?? '',
    pricingMethod: isFixed ? 'fixed' : 'tm',
    linesAdded: lineCount('add'),
    linesEdited: lineCount('edit'),
    linesRemoved: lineCount('remove'),
    ...(await requesterPayload(sent.requestedByUserId, recipientId, engagement.company.id)),
    ...(clientPriceChangeLabel === undefined ? {} : { clientPriceChangeLabel }),
    ...(estimateChangeLabel === undefined ? {} : { estimateChangeLabel }),
  }).catch(() => {
    // publishNotificationEvent logs internally.
  });
}

/**
 * The expert saves a change as a draft, or saves and sends it. Gated on the engagement
 * capability `manage_engagement`. With no open order a fresh draft is opened; an open client
 * `requested` order becomes the draft; an open draft has its lines replaced. A fixed-price
 * change carries the entered total (the price, or the cap on T&M) and the repository turns it
 * into the signed expert-side delta under the engagement lock. Sending runs the repository's coherence
 * check: a failure leaves the saved draft and returns the rule's message. Fires
 * `CHANGE_ORDER_SENT` and publishes `change_order.sent` on send only. The note is never
 * logged.
 */
export async function saveChangeOrderAction(
  input: SaveChangeOrderInput
): Promise<SaveChangeOrderResult> {
  const auth = await requireSignedInUser();
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const parsed = saveChangeOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { engagementId, orderId, note, newTotalCents, lines: drafts, send } = parsed.data;
  const { user } = auth;

  let savedId: string | undefined;
  const outcome = await runEngagementLifecycleAction(
    engagementId,
    { userId: user.id, send },
    'Failed to save change order',
    () => gateChangeOrderExpert(user, engagementId),
    async (engagement, authorized) => {
      const built = toLineInputs(drafts, engagement);
      if (!built.ok) {
        return { success: false, error: built.error };
      }

      const repo = engagementChangeOrdersRepository;
      const content = {
        engagementId,
        userId: user.id,
        note: note === '' ? null : note,
        newTotalCents: newTotalCents ?? null,
        lines: built.lines,
      };

      const orders = await repo.listForEngagement(engagementId);
      const open = orders.find((order) => order.decidedAt === null && order.withdrawnAt === null);
      const persisted = await persistDraft(open, orderId, content);
      if (!persisted.ok) {
        return { success: false, error: persisted.error };
      }
      const { saved } = persisted;
      savedId = saved.id;

      if (!send) {
        log.info('Change order draft saved', {
          engagementId,
          changeOrderId: saved.id,
          userId: user.id,
          pricing_method: engagement.pricingMethod,
          line_count: saved.lines.length,
        });
        return { success: true };
      }

      const sent = await repo.send({ engagementId, orderId: saved.id, userId: user.id });
      trackServerAndFlush(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_SENT, {
        ...changeOrderLinesProps(sent, engagement.pricingMethod, user.id),
        acting_as: authorized.actor.actingAs,
      });
      await publishSent(
        engagement,
        sent,
        effectiveExpertPriceCents(engagement.priceCents, orders),
        user
      );

      log.info('Change order sent', {
        engagementId,
        changeOrderId: sent.id,
        userId: user.id,
        pricing_method: engagement.pricingMethod,
        line_count: sent.lines.length,
      });
      return { success: true };
    }
  );
  if (!outcome.success && savedId !== undefined) {
    revalidatePath(`/engagements/${engagementId}`);
  }
  return outcome.success
    ? { success: true, ...(savedId === undefined ? {} : { changeOrderId: savedId }) }
    : { ...outcome, ...(savedId === undefined ? {} : { changeOrderId: savedId }) };
}
