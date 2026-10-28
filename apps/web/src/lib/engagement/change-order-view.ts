import 'server-only';

import type {
  ChangeOrderStatus,
  ChangeOrderWithLines,
  ProjectEngagementWithMilestones,
} from '@balo/db';
import {
  changeOrderMinutesDelta,
  clientPriceChangeCents,
  hoursLabel,
  isChangeOrderStale,
} from '@balo/shared/engagements';
import { applyBaloFee } from '@balo/shared/pricing';
import { businessDaysBetween } from '@balo/shared/timezone';
import { formatShortUtc } from '@/lib/format/utc-date';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { formatHours, signedHours, signedMoney } from './change-order-format';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import {
  expertSideActorLabel,
  personAtCompany,
  type EngagementParties,
} from './engagement-parties';
import type { EngagementViewerContext } from './resolve-engagement-lens';

/**
 * The change-order panel's serializable contract (BAL-622). `mapChangeOrdersToView` is the
 * ONE place a change order becomes copy and money for a viewer; components read the derived
 * strings and never touch `@balo/db`.
 *
 * FEE CONCEALMENT. Amounts are lens-scoped: the client lens shows client figures (the expert
 * price grossed up with `applyBaloFee`, deltas through `clientPriceChangeCents`), the expert
 * and admin lenses show the raw expert-side figures. Both sides of an amount appear together
 * only in `change-order-admin-view.ts`. Affordances key on the lens for PRESENTATION; every
 * action re-gates on a capability.
 */

export type ChangeOrderPillTone = 'amber' | 'slate' | 'violet' | 'emerald';

/**
 * One milestone amendment. `estimateLabel` is the bare hours figure ("10 hrs"), set on
 * time-and-materials projects only; the component adds any "Estimate" prefix.
 */
export interface ChangeOrderLineView {
  op: 'add' | 'edit' | 'remove';
  title: string;
  descriptionText: string | null;
  estimateLabel: string | null;
  /**
   * The hours already logged on the milestone ("12 hrs logged so far"), with " · already past
   * the new estimate" once they reach it. Set only on a sent T&M order's edit that changes the
   * estimate of a milestone with time logged; never on history, where the figure has moved on.
   */
  loggedLabel: string | null;
  /** The milestone as it was when the change was sent (edit lines); null when not stamped. */
  before: {
    title: string;
    descriptionText: string | null;
    estimateLabel: string | null;
  } | null;
}

/**
 * The money or estimate effect of an order. On T&M, `capText` carries the cap change when the
 * order moves it ("Cap A$40,000 → A$45,000 (+A$5,000)"), beside the estimate in `text`.
 */
export interface ChangeOrderPriceEffectView {
  text: string;
  capText?: string;
  hint: string | null;
}

export interface ChangeOrderItemView {
  id: string;
  status: ChangeOrderStatus;
  /** The project's pricing method (the repository enum's literals). */
  pricingMethod: 'fixed' | 'tm';
  /** "19 Oct" when the order was sent, else null. */
  sentOnLabel: string | null;
  /** Who sent it, retrospective ("Charles @ CloudPeak"); null until sent. */
  sentByLabel: string | null;
  pill: { label: string; tone: ChangeOrderPillTone };
  /** The expert's "what's changing and why"; null until written or when not visible. */
  summary: string | null;
  /** The client's request note; null when the expert opened the order. */
  requestNote: string | null;
  /** Who asked and when, lens-worded ("Dana @ Northwind asked for a change on 15 Oct"). */
  requestedHeading: string | null;
  /** The dates line, e.g. "Requested 15 Oct · Sent 18 Oct · Approved 20 Oct". */
  datesLabel: string;
  lines: ChangeOrderLineView[];
  priceEffect: ChangeOrderPriceEffectView | null;
  /** The compact price or estimate change shown on a history row; null when there are no lines. */
  deltaChip: string | null;
  /** The expert's answer to a request, set when the order was answered without a change. */
  answerText: string | null;
  /** The client's reason for declining a sent change. */
  declineText: string | null;
}

export interface ChangeOrderAffordances {
  /** The client may open a request now (client lens, active project, nothing open). */
  requestChange: boolean;
  /** The expert may open the composer for a fresh change or from the open request. */
  propose: boolean;
  /** The expert may answer the open request without a change order. */
  answer: boolean;
  /** The expert has a draft to continue. */
  continueDraft: boolean;
  discardDraft: boolean;
  /** The expert may withdraw the sent change. */
  withdraw: boolean;
  /** The client may approve or decline the sent change (they hold the approval capability). */
  decide: boolean;
  /** Shown instead of the decide buttons to a client-side viewer who cannot decide; names the party. */
  decideNotice: string | null;
  proposeDisabledReason: string | null;
}

export interface ChangeOrderPanelView {
  open: ChangeOrderItemView | null;
  affordances: ChangeOrderAffordances;
  /** The latest decided order's banner, shown only while nothing is open. */
  outcome: { tone: 'emerald' | 'slate'; text: string } | null;
  /** Closed orders, newest first. */
  history: ChangeOrderItemView[];
  composerHref: string;
  footnote: string;
  /** Admin lens only: where the open order stands. */
  adminStateLine: string | null;
}

type LensName = EngagementViewerContext['lens'];

export { formatHours, signedHours, signedMoney };

/** An order that has left the expert's desk: a client asked for it, or it was sent. */
function isVisibleOrder(order: ChangeOrderWithLines): boolean {
  return order.requestedAt !== null || order.sentAt !== null;
}

function isOpenOrder(order: ChangeOrderWithLines): boolean {
  return order.decidedAt === null && order.withdrawnAt === null;
}

/** The engagement's open order, or null. At most one can be open. */
export function findOpenOrder(
  orders: readonly ChangeOrderWithLines[]
): ChangeOrderWithLines | null {
  return orders.find(isOpenOrder) ?? null;
}

/** Expert-side effective price: the accepted price plus every approved delta. */
export function effectiveExpertPriceCents(
  acceptedPriceCents: number,
  orders: readonly ChangeOrderWithLines[]
): number {
  return orders.reduce(
    (sum, order) => (order.status === 'approved' ? sum + (order.priceDeltaCents ?? 0) : sum),
    acceptedPriceCents
  );
}

function plainOrNull(html: string | null): string | null {
  if (html === null || html.trim() === '') return null;
  return htmlToPlainText(html) || null;
}

type OrderLine = ChangeOrderWithLines['lines'][number];

/** The hours already logged on an edit's milestone, for a sent T&M order that moves its estimate. */
function loggedLabelFor(
  line: OrderLine,
  order: ChangeOrderWithLines,
  vc: ViewContext
): string | null {
  const next = line.estimatedMinutes;
  const milestoneId = line.engagementMilestoneId;
  if (vc.engagement.pricingMethod !== 'tm' || order.status !== 'sent') return null;
  if (line.op !== 'edit' || next === null || milestoneId === null) return null;
  const previous =
    line.beforeTitle === null
      ? (vc.engagement.milestones.find((m) => m.id === milestoneId)?.estimatedMinutes ?? null)
      : line.beforeEstimatedMinutes;
  const logged = vc.loggedMinutesByMilestone[milestoneId] ?? 0;
  if (next === previous || logged <= 0) return null;
  const label = `${hoursLabel(logged)} logged so far`;
  return logged >= next ? `${label} · already past the new estimate` : label;
}

function mapLines(order: ChangeOrderWithLines, vc: ViewContext): ChangeOrderLineView[] {
  const isTm = vc.engagement.pricingMethod === 'tm';
  const estimate = (minutes: number | null): string | null =>
    isTm && minutes !== null ? formatHours(minutes) : null;
  return order.lines.map((line) => ({
    op: line.op,
    title: line.title,
    descriptionText: plainOrNull(line.descriptionHtml),
    estimateLabel: estimate(line.estimatedMinutes),
    loggedLabel: loggedLabelFor(line, order, vc),
    before:
      line.beforeTitle === null
        ? null
        : {
            title: line.beforeTitle,
            descriptionText: plainOrNull(line.beforeDescriptionHtml),
            estimateLabel: estimate(line.beforeEstimatedMinutes),
          },
  }));
}

function minutesDelta(order: ChangeOrderWithLines): number {
  return changeOrderMinutesDelta(
    order.lines.map((line) => ({
      op: line.op,
      estimatedMinutes: line.estimatedMinutes,
      beforeEstimatedMinutes: line.beforeEstimatedMinutes,
    }))
  );
}

interface ViewContext {
  engagement: ProjectEngagementWithMilestones;
  lens: LensName;
  parties: EngagementParties;
  orders: readonly ChangeOrderWithLines[];
  /** The viewer holds `approve_own_proposals` for the client company. */
  canDecide: boolean;
  now: Date;
  /** T&M: minutes of live time logged per milestone. */
  loggedMinutesByMilestone: Readonly<Record<string, number>>;
  /** The signed-in viewer, so "You" is only ever said about the viewer's own act. */
  viewerUserId: string | null;
}

/** The expert-side person behind an order's act, named from the viewer's engagement. */
function expertActor(
  actor: ChangeOrderWithLines['sentBy'],
  vc: Pick<ViewContext, 'engagement' | 'parties'>
): string {
  return expertSideActorLabel(vc.engagement, vc.parties, actor);
}

/** Σ approved deltas of the orders strictly before / after `index`, by the chosen measure. */
function approvedSum(
  orders: readonly ChangeOrderWithLines[],
  measure: (order: ChangeOrderWithLines) => number,
  range: { from: number; to: number }
): number {
  return orders
    .slice(range.from, range.to)
    .reduce((sum, order) => (order.status === 'approved' ? sum + measure(order) : sum), 0);
}

function currentEstimateMinutes(engagement: ProjectEngagementWithMilestones): number {
  return engagement.milestones.reduce((sum, m) => sum + (m.estimatedMinutes ?? 0), 0);
}

/**
 * The order's price (fixed) or cap (T&M) movement in the viewer's terms: the client sees the
 * grossed-up figures and the change between them, everyone else the expert-side figures.
 */
function moneyMovement(
  order: ChangeOrderWithLines,
  index: number,
  vc: ViewContext
): { from: number; to: number; shown: number } {
  const { engagement, lens } = vc;
  const delta = order.priceDeltaCents ?? 0;
  const earlier = approvedSum(vc.orders, (o) => o.priceDeltaCents ?? 0, { from: 0, to: index });
  const fromExpert = engagement.priceCents + earlier;
  const toExpert = fromExpert + delta;
  if (lens !== 'client') return { from: fromExpert, to: toExpert, shown: delta };
  return {
    from: applyBaloFee(fromExpert, engagement.baloFeeBps),
    to: applyBaloFee(toExpert, engagement.baloFeeBps),
    shown: clientPriceChangeCents(fromExpert, toExpert, engagement.baloFeeBps),
  };
}

function tmPriceEffect(
  order: ChangeOrderWithLines,
  index: number,
  settled: boolean,
  vc: ViewContext
): ChangeOrderPriceEffectView {
  const delta = minutesDelta(order);
  const later = approvedSum(vc.orders, minutesDelta, { from: index + 1, to: vc.orders.length });
  const base = currentEstimateMinutes(vc.engagement) - later;
  const isApproved = order.status === 'approved';
  const from = isApproved ? base - delta : base;
  const to = isApproved ? base : base + delta;
  const { currency } = vc.engagement;
  const cap = moneyMovement(order, index, vc);
  const capMoves = cap.shown !== 0;
  const billedNote = "You're billed for the time logged, as now.";
  let hint: string | null = null;
  if (!settled && vc.lens === 'client') {
    hint = capMoves ? `${billedNote} The cap is the most that can be billed.` : billedNote;
  }
  return {
    text: `Estimate ${formatHours(from)} → ${formatHours(to)} (${signedHours(delta)})`,
    ...(capMoves
      ? {
          capText: `Cap ${formatWholeCurrency(cap.from, currency)} → ${formatWholeCurrency(cap.to, currency)} (${signedMoney(cap.shown, currency)})`,
        }
      : {}),
    hint,
  };
}

function fixedPriceEffect(
  order: ChangeOrderWithLines,
  index: number,
  settled: boolean,
  vc: ViewContext
): ChangeOrderPriceEffectView {
  const { engagement, lens, parties } = vc;
  const { currency } = engagement;
  const isClient = lens === 'client';
  const { from, to, shown } = moneyMovement(order, index, vc);
  if (shown === 0) return { text: "The price doesn't change.", hint: null };

  const text = `Project price ${formatWholeCurrency(from, currency)} → ${formatWholeCurrency(to, currency)} (${signedMoney(shown, currency)})`;
  if (settled) return { text, hint: null };
  if (isClient) {
    const amount = formatWholeCurrency(Math.abs(shown), currency);
    return {
      text,
      hint:
        shown > 0
          ? `If you approve, ${amount} is added to your final invoice.`
          : `If you approve, ${amount} comes off your final invoice.`,
    };
  }
  return {
    text,
    hint: `If ${parties.clientCompanyName} approves, the difference is settled at the end of the project.`,
  };
}

function priceEffectFor(
  order: ChangeOrderWithLines,
  index: number,
  settled: boolean,
  vc: ViewContext
): ChangeOrderPriceEffectView | null {
  // A request carries no change yet, and an answered request never will.
  if (order.status === 'requested' || (order.status === 'declined' && order.sentAt === null)) {
    return null;
  }
  return vc.engagement.pricingMethod === 'tm'
    ? tmPriceEffect(order, index, settled, vc)
    : fixedPriceEffect(order, index, settled, vc);
}

function deltaChipFor(order: ChangeOrderWithLines, index: number, vc: ViewContext): string | null {
  if (order.sentAt === null) return null;
  const { engagement } = vc;
  const { shown } = moneyMovement(order, index, vc);
  if (engagement.pricingMethod === 'tm') {
    const hours = signedHours(minutesDelta(order));
    return shown === 0 ? hours : `${hours} · cap ${signedMoney(shown, engagement.currency)}`;
  }
  return signedMoney(shown, engagement.currency);
}

function pillFor(
  order: ChangeOrderWithLines,
  lens: LensName,
  parties: EngagementParties
): { label: string; tone: ChangeOrderPillTone } {
  const client = parties.clientCompanyName;
  const isClient = lens === 'client';
  switch (order.status) {
    case 'requested':
      return { tone: 'amber', label: isClient ? 'Requested' : `Request from ${client}` };
    case 'draft':
      return isClient ? { tone: 'amber', label: 'Requested' } : { tone: 'slate', label: 'Draft' };
    case 'sent':
      return {
        tone: 'violet',
        label: isClient ? 'Waiting on you' : `Waiting on ${client}`,
      };
    case 'approved':
      return { tone: 'emerald', label: 'Approved' };
    case 'declined':
      return { tone: 'slate', label: order.sentAt === null ? 'Answered' : 'Declined' };
    case 'withdrawn':
      return { tone: 'slate', label: 'Withdrawn' };
  }
}

function requestedHeadingFor(order: ChangeOrderWithLines, vc: ViewContext): string | null {
  if (order.requestedAt === null) return null;
  const date = formatShortUtc(order.requestedAt);
  if (vc.lens === 'client') return `You asked for a change on ${date}`;
  const who = personAtCompany(order.requestedBy, vc.parties.clientCompanyName);
  return `${who} asked for a change on ${date}`;
}

function decisionVerb(order: ChangeOrderWithLines): string {
  if (order.status === 'approved') return 'Approved';
  return order.sentAt === null ? 'Answered' : 'Declined';
}

function datesLabelFor(order: ChangeOrderWithLines): string {
  const parts: string[] = [];
  if (order.requestedAt !== null) parts.push(`Requested ${formatShortUtc(order.requestedAt)}`);
  if (order.sentAt !== null) parts.push(`Sent ${formatShortUtc(order.sentAt)}`);
  if (order.decidedAt !== null) {
    parts.push(`${decisionVerb(order)} ${formatShortUtc(order.decidedAt)}`);
  }
  if (order.withdrawnAt !== null) parts.push(`Withdrawn ${formatShortUtc(order.withdrawnAt)}`);
  return parts.length > 0 ? parts.join(' · ') : 'Draft';
}

function answerTextFor(order: ChangeOrderWithLines, vc: ViewContext): string | null {
  if (order.status !== 'declined' || order.sentAt !== null || order.declineReason === null) {
    return null;
  }
  const who =
    order.decidedBy !== null && order.decidedBy.id === vc.viewerUserId
      ? 'You'
      : expertActor(order.decidedBy, vc);
  return `${who} answered: “${order.declineReason}”`;
}

function declineTextFor(order: ChangeOrderWithLines, vc: ViewContext): string | null {
  if (order.status !== 'declined' || order.sentAt === null || order.declineReason === null) {
    return null;
  }
  const who =
    vc.lens === 'client'
      ? 'You declined'
      : `${personAtCompany(order.decidedBy, vc.parties.clientCompanyName)} declined`;
  return `${who}: “${order.declineReason}”`;
}

function mapItem(order: ChangeOrderWithLines, index: number, vc: ViewContext): ChangeOrderItemView {
  const settled = !isOpenOrder(order);
  const showsDetail = order.sentAt !== null || vc.lens !== 'client';
  return {
    id: order.id,
    status: order.status,
    pricingMethod: vc.engagement.pricingMethod,
    sentOnLabel: order.sentAt === null ? null : formatShortUtc(order.sentAt),
    sentByLabel: order.sentAt === null ? null : expertActor(order.sentBy, vc),
    pill: pillFor(order, vc.lens, vc.parties),
    summary: showsDetail ? order.note : null,
    requestNote: order.requestNote,
    requestedHeading: requestedHeadingFor(order, vc),
    datesLabel: datesLabelFor(order),
    lines: showsDetail ? mapLines(order, vc) : [],
    priceEffect: showsDetail ? priceEffectFor(order, index, settled, vc) : null,
    deltaChip: showsDetail ? deltaChipFor(order, index, vc) : null,
    answerText: answerTextFor(order, vc),
    declineText: declineTextFor(order, vc),
  };
}

type PanelOutcome = ChangeOrderPanelView['outcome'];

function planUpdatedText(order: ChangeOrderWithLines, vc: ViewContext): string {
  if (vc.engagement.pricingMethod === 'fixed') return 'The plan and price are updated.';
  return (order.priceDeltaCents ?? 0) === 0
    ? 'The plan and estimates are updated.'
    : 'The plan, estimates and cap are updated.';
}

function expertOutcomeFor(latest: ChangeOrderWithLines, vc: ViewContext): PanelOutcome {
  const decidedOn = latest.decidedAt === null ? '' : formatShortUtc(latest.decidedAt);
  if (latest.status === 'approved') {
    return {
      tone: 'emerald',
      text: `${vc.parties.clientCompanyName} approved the change on ${decidedOn}. ${planUpdatedText(latest, vc)}`,
    };
  }
  if (latest.status === 'declined' && latest.sentAt !== null) {
    const who = personAtCompany(latest.decidedBy, vc.parties.clientCompanyName);
    return {
      tone: 'slate',
      text: `${who} declined the change on ${decidedOn}: “${latest.declineReason ?? ''}”`,
    };
  }
  return null;
}

function withdrawnSuffix(latest: ChangeOrderWithLines): string {
  if (latest.withdrawnAt === null) return '';
  return ` on ${formatShortUtc(latest.withdrawnAt)}`;
}

function clientOutcomeFor(latest: ChangeOrderWithLines, vc: ViewContext): PanelOutcome {
  if (latest.status === 'approved') {
    const decidedOn = latest.decidedAt === null ? '' : formatShortUtc(latest.decidedAt);
    return {
      tone: 'emerald',
      text: `You approved the change on ${decidedOn}. ${planUpdatedText(latest, vc)}`,
    };
  }
  if (latest.status === 'declined' && latest.sentAt === null) {
    const who = expertActor(latest.decidedBy, vc);
    return { tone: 'slate', text: `${who} answered your request: “${latest.declineReason ?? ''}”` };
  }
  if (latest.status === 'withdrawn' && latest.sentAt !== null) {
    const who = expertActor(latest.withdrawnBy, vc);
    return {
      tone: 'slate',
      text: `${who} withdrew the proposed change${withdrawnSuffix(latest)}. Nothing changed.`,
    };
  }
  return null;
}

function outcomeFor(latest: ChangeOrderWithLines | undefined, vc: ViewContext): PanelOutcome {
  if (latest === undefined || vc.lens === 'admin') return null;
  return vc.lens === 'expert' ? expertOutcomeFor(latest, vc) : clientOutcomeFor(latest, vc);
}

function affordancesFor(
  open: ChangeOrderWithLines | null,
  vc: ViewContext
): ChangeOrderAffordances {
  const active = vc.engagement.status === 'active';
  const isExpert = vc.lens === 'expert' && active;
  const isClient = vc.lens === 'client' && active;
  const status = open?.status ?? null;
  const awaitingDecision = isClient && status === 'sent';
  return {
    requestChange: isClient && open === null,
    propose: isExpert && (open === null || status === 'requested'),
    answer: isExpert && status === 'requested',
    continueDraft: isExpert && status === 'draft',
    discardDraft: isExpert && status === 'draft',
    withdraw: isExpert && status === 'sent',
    decide: awaitingDecision && vc.canDecide,
    decideNotice:
      awaitingDecision && !vc.canDecide
        ? `Anyone who can approve proposals for ${vc.parties.clientCompanyName} can approve or decline this.`
        : null,
    proposeDisabledReason:
      isExpert && status === 'sent'
        ? `A change is already waiting on ${vc.parties.clientCompanyName}`
        : null,
  };
}

function footnoteFor(vc: ViewContext): string {
  const { lens, parties, engagement } = vc;
  if (lens === 'admin') return 'Amounts on the panel above are visible to Balo staff only.';
  const isFixed = engagement.pricingMethod === 'fixed';
  if (lens === 'client') {
    const lead = `${parties.expertPartyShort} can tidy the wording of a milestone at any time, and you'll be told.`;
    return isFixed
      ? `${lead} Anything that changes scope or price comes to you to approve first. Approved price changes are settled on your final invoice.`
      : `${lead} Anything that adds scope or raises an estimate comes to you to approve first. You're billed for the time logged, as now.`;
  }
  const client = parties.clientCompanyName;
  return `Wording edits apply straight away and ${client} is told. Changes to scope or price go to ${client} as a change, and nothing changes until they approve. One change can be open at a time.`;
}

function adminStateLineFor(open: ChangeOrderWithLines | null, vc: ViewContext): string | null {
  if (vc.lens !== 'admin' || open === null) return null;
  const { clientCompanyName, expertPartyShort } = vc.parties;
  if (open.status === 'sent' && open.sentAt !== null) {
    const days = businessDaysBetween(open.sentAt, vc.now);
    const base = `Waiting on ${clientCompanyName} since ${formatShortUtc(open.sentAt)} (${days} business days).`;
    return isChangeOrderStale(open.sentAt, vc.now)
      ? `${base} It's in the pending-actions queue.`
      : base;
  }
  if (open.status === 'draft') return `${expertPartyShort} is drafting a change.`;
  if (open.status === 'requested') {
    return `${clientCompanyName} asked for a change. Waiting on ${expertPartyShort}.`;
  }
  return null;
}

/** The optional settings of {@link mapChangeOrdersToView}. */
export interface ChangeOrderViewOptions {
  /** The clock, injectable for deterministic tests. Defaults to now. */
  now?: Date;
  /** T&M: minutes of live time logged per milestone, shown on a sent order's estimate edits. */
  loggedMinutesByMilestone?: Readonly<Record<string, number>>;
  /** The signed-in viewer, so "You" is only ever said about the viewer's own act. */
  viewerUserId?: string | null;
}

/**
 * Map the engagement's change orders (oldest first, as the repository lists them) into the
 * panel view for one viewer. `canDecide` is the viewer's `approve_own_proposals` capability
 * for the client company, resolved by the caller. The optional settings are in
 * {@link ChangeOrderViewOptions}.
 */
export function mapChangeOrdersToView(
  orders: readonly ChangeOrderWithLines[],
  engagement: ProjectEngagementWithMilestones,
  ctx: EngagementViewerContext,
  parties: EngagementParties,
  canDecide: boolean,
  options: ChangeOrderViewOptions = {}
): ChangeOrderPanelView {
  const { now = new Date(), loggedMinutesByMilestone = {}, viewerUserId = null } = options;
  const vc: ViewContext = {
    engagement,
    lens: ctx.lens,
    parties,
    orders,
    canDecide,
    now,
    loggedMinutesByMilestone,
    viewerUserId,
  };
  const open = findOpenOrder(orders);
  const indexed = orders.map((order, index) => ({ order, index }));
  const openItem = indexed.find(
    ({ order }) => order === open && (ctx.lens !== 'client' || isVisibleOrder(order))
  );
  const closed = indexed
    .filter(({ order }) => !isOpenOrder(order) && isVisibleOrder(order))
    .reverse();

  const latestClosed = open === null ? closed[0]?.order : undefined;
  return {
    open: openItem === undefined ? null : mapItem(openItem.order, openItem.index, vc),
    affordances: affordancesFor(open, vc),
    outcome: outcomeFor(latestClosed, vc),
    history: closed.map(({ order, index }) => mapItem(order, index, vc)),
    composerHref: `/engagements/${engagement.id}/change-order`,
    footnote: footnoteFor(vc),
    adminStateLine: adminStateLineFor(open, vc),
  };
}
