import 'server-only';

import type { ChangeOrderWithLines, ProjectEngagementWithMilestones } from '@balo/db';
import {
  changeOrderMinutesDelta,
  clientPriceChangeCents,
  type ProjectSettlement,
} from '@balo/shared/engagements';
import { formatShortUtc } from '@/lib/format/utc-date';
import { formatWholeCurrency } from '@/lib/utils/currency';
import type { EngagementParties } from './engagement-parties';
import { formatHours, signedHours, signedMoney } from './change-order-view';

/**
 * The Balo-staff money view of a project's change orders: BOTH sides of every amount, the
 * margin, and the final-invoice figure. Staff only. Imported ONLY by the engagement page,
 * behind the `VIEW_PLATFORM_ADMIN` platform capability
 * (`change-order-admin-view-single-importer.test.ts`), so no client or expert surface can
 * reach an amount of the other side.
 */
export type ChangeOrderAdminMoneyView =
  | {
      kind: 'fixed';
      rows: {
        label: string;
        expert: string;
        client: string;
        margin: string;
        strong: boolean;
      }[];
      /** What the client was invoiced up front, shown as a deduction ("-A$3,125"). */
      upfrontLabel: string;
      finalInvoiceLabel: string;
      finalInvoiceNegative: boolean;
      pendingNote: string | null;
      creditNeededText: string | null;
      footnote: string;
    }
  | {
      kind: 'tm';
      rows: { label: string; value: string; strong: boolean }[];
      pendingNote: string | null;
      footnote: string;
    };

function approvedInDecisionOrder(orders: readonly ChangeOrderWithLines[]): ChangeOrderWithLines[] {
  return orders
    .filter((order) => order.status === 'approved' && order.decidedAt !== null)
    .sort(
      (a, b) =>
        (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0) || a.id.localeCompare(b.id)
    );
}

function decidedOn(order: ChangeOrderWithLines | undefined): string {
  const decidedAt = order?.decidedAt ?? null;
  return decidedAt === null ? '' : ` ${formatShortUtc(decidedAt)}`;
}

function sentOrder(orders: readonly ChangeOrderWithLines[]): ChangeOrderWithLines | undefined {
  return orders.find((order) => order.status === 'sent');
}

function fixedView(
  settlement: ProjectSettlement,
  orders: readonly ChangeOrderWithLines[],
  engagement: ProjectEngagementWithMilestones,
  parties: EngagementParties
): ChangeOrderAdminMoneyView {
  const { currency } = engagement;
  const money = (cents: number): string => formatWholeCurrency(cents, currency);
  const approved = approvedInDecisionOrder(orders);
  const { accepted, current } = settlement;

  const rows = [
    {
      label: 'Accepted price',
      expert: money(accepted.expertCents),
      client: money(accepted.clientCents),
      margin: money(accepted.marginCents),
      strong: false,
    },
    ...settlement.approved.map((delta, index) => ({
      label: `Change approved${decidedOn(approved[index])}`,
      expert: signedMoney(delta.expertDeltaCents, currency),
      client: signedMoney(delta.clientDeltaCents, currency),
      margin: signedMoney(delta.marginDeltaCents, currency),
      strong: false,
    })),
    {
      label: 'Current price',
      expert: money(current.expertCents),
      client: money(current.clientCents),
      margin: money(current.marginCents),
      strong: true,
    },
  ];

  const sent = sentOrder(orders);
  let pendingNote: string | null = null;
  if (sent !== undefined) {
    const delta = sent.priceDeltaCents ?? 0;
    const clientDelta = clientPriceChangeCents(
      current.expertCents,
      current.expertCents + delta,
      engagement.baloFeeBps
    );
    pendingNote = `Waiting on ${parties.clientCompanyName}: ${signedMoney(delta, currency)} expert, ${signedMoney(clientDelta, currency)} client (not in the totals yet).`;
  }

  const creditNeededText =
    settlement.creditRequiredClientCents > 0
      ? `Credit needed: ${money(settlement.creditRequiredClientCents)}. The approved change took the price below what ${parties.clientCompanyName} has already been invoiced. Issue an adjustment note, then close the item in the pending-actions queue.`
      : null;

  return {
    kind: 'fixed',
    rows,
    upfrontLabel: money(-settlement.upfrontClientCents),
    finalInvoiceLabel: money(settlement.finalInvoiceClientCents),
    finalInvoiceNegative: settlement.finalInvoiceClientCents < 0,
    pendingNote,
    creditNeededText,
    footnote:
      'Under v1 manual invoicing, the final invoice figure is what goes into Xero when the project is accepted.',
  };
}

function minutesOf(order: ChangeOrderWithLines): number {
  return changeOrderMinutesDelta(
    order.lines.map((line) => ({
      op: line.op,
      estimatedMinutes: line.estimatedMinutes,
      beforeEstimatedMinutes: line.beforeEstimatedMinutes,
    }))
  );
}

function tmView(
  settlement: ProjectSettlement,
  orders: readonly ChangeOrderWithLines[],
  engagement: ProjectEngagementWithMilestones,
  parties: EngagementParties
): ChangeOrderAdminMoneyView {
  const approved = approvedInDecisionOrder(orders);
  const current = engagement.milestones.reduce((sum, m) => sum + (m.estimatedMinutes ?? 0), 0);
  const approvedMinutes = approved.reduce((sum, order) => sum + minutesOf(order), 0);
  const { currency } = engagement;
  const bothSides = (expertCents: number, clientCents: number, signed: boolean): string => {
    const format = signed ? signedMoney : formatWholeCurrency;
    return `${format(expertCents, currency)} expert · ${format(clientCents, currency)} client`;
  };

  const rows = [
    { label: 'Accepted estimate', value: formatHours(current - approvedMinutes), strong: false },
    ...approved.map((order) => ({
      label: `Change approved${decidedOn(order)}`,
      value: signedHours(minutesOf(order)),
      strong: false,
    })),
    { label: 'Current estimate', value: formatHours(current), strong: true },
    {
      label: 'Accepted cap',
      value: bothSides(settlement.accepted.expertCents, settlement.accepted.clientCents, false),
      strong: false,
    },
    ...settlement.approved
      .map((delta, index) => ({ delta, order: approved[index] }))
      .filter(({ delta }) => delta.expertDeltaCents !== 0)
      .map(({ delta, order }) => ({
        label: `Cap change approved${decidedOn(order)}`,
        value: bothSides(delta.expertDeltaCents, delta.clientDeltaCents, true),
        strong: false,
      })),
    {
      label: 'Current cap',
      value: bothSides(settlement.current.expertCents, settlement.current.clientCents, false),
      strong: true,
    },
  ];

  const sent = sentOrder(orders);
  let pendingNote: string | null = null;
  if (sent !== undefined) {
    const capDelta = sent.priceDeltaCents ?? 0;
    const capClause =
      capDelta === 0
        ? ''
        : `, cap ${signedMoney(capDelta, currency)} expert, ${signedMoney(
            clientPriceChangeCents(
              settlement.current.expertCents,
              settlement.current.expertCents + capDelta,
              engagement.baloFeeBps
            ),
            currency
          )} client`;
    pendingNote = `Waiting on ${parties.clientCompanyName}: ${signedHours(minutesOf(sent))}${capClause} (not in the totals yet).`;
  }
  return {
    kind: 'tm',
    rows,
    pendingNote,
    footnote:
      'Billed each period from logged time, up to the cap. A change order moves the estimate and, when it says so, the cap.',
  };
}

export function mapChangeOrderAdminView(
  settlement: ProjectSettlement,
  orders: readonly ChangeOrderWithLines[],
  engagement: ProjectEngagementWithMilestones,
  parties: EngagementParties
): ChangeOrderAdminMoneyView {
  return engagement.pricingMethod === 'tm'
    ? tmView(settlement, orders, engagement, parties)
    : fixedView(settlement, orders, engagement, parties);
}
