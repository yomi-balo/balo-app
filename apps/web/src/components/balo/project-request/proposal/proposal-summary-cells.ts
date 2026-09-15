/**
 * The ONE definition of the proposal summary box's cell strings (BAL-392).
 *
 * Consumed by BOTH client-facing surfaces — the generated PDF
 * (`lib/project-request/proposal/pdf/proposal-pdf-document.tsx`) and the shared web
 * `ProposalDoc` with `showSummaryCells` on — AND by the sticky accept card that renders
 * beside the grid (`review-summary-card.tsx`). These are money-adjacent claims on a
 * document a client may sign against and the page they press Accept on; if they drifted
 * they would make different statements about when money is due for the same proposal —
 * the card once said `Deposit + monthly` beside a grid saying `Rate only`, in one
 * viewport. One rule, one definition — do not write a second copy.
 *
 * Pure and surface-neutral on purpose: no React, no JSX, no `@balo/db`, no `server-only`,
 * no `Intl`/`Date`/environment reads. It is imported by a `'use client'` component AND by
 * server-only PDF code.
 */
import type { ProposalReviewDoc } from './proposal-review-types';

export type ProposalSummaryCellKey = 'pricing' | 'timeline' | 'payment' | 'deliverables';

export interface ProposalSummaryCell {
  key: ProposalSummaryCellKey;
  /**
   * Sentence-case. BOTH surfaces uppercase it PRESENTATIONALLY (`textTransform` in the
   * PDF, `uppercase` in Tailwind), so the rendered output matches the design reference
   * (`PRICING` / `EST. TIMELINE` / `PAYMENT` / `DELIVERABLES`) while a screen reader still
   * hears "Est." rather than an all-caps token.
   */
  label: string;
  value: string;
}

/** The shared "not specified" glyph (EM DASH U+2014) — TIMELINE, PAYMENT and DELIVERABLES. */
export const SUMMARY_EMPTY_VALUE = '—';

/**
 * The longest composed `"{pct}% {label}"` PAYMENT string that stays on one line.
 *
 * MEASURED, not estimated. Usable PDF cell text width is 95.32 pt: A4 595.28 − 96 page
 * padding − 2 box border = 497.28, ÷ 4 cells = 124.32, − 28 cell padding − 1 hairline
 * divider. Geist-600 at 10 pt was measured with `fontkit` over 162 realistic composed
 * strings; 95.32 ÷ 5.551 pt-per-char (the densest string that still fits,
 * `30% on acceptance` at 94.36 pt ÷ 17) = 17.17 → 17.
 *
 * 17 is also the largest count at which the whole `{pct}% on acceptance` /
 * `on completion` / `upfront` / `final payment` family survives — the exact family this
 * rule exists to preserve, since collapsing them to "N payments" is what a literal
 * "30% upfront" would misstate. 15 (the only fully safe count) collapses
 * `30% on acceptance` and was rejected for that reason.
 *
 * ⚠ Character count correlates only WEAKLY with rendered width (a 16-char string can
 * overflow while a 19-char one fits), so the count is not trusted on its own: it decides
 * only "composed string vs N payments". Box geometry is guaranteed separately by a real
 * one-line clamp on each surface (`maxLines: 1` + `textOverflow: 'ellipsis'` in the PDF,
 * `truncate` on web). Six of the 162 sampled strings pass 17 yet still overflow; they
 * render ellipsised, which is an accepted trade-off, not a defect.
 */
export const PROPOSAL_SUMMARY_MAX_VALUE_CHARS = 17;

/**
 * ⚠ Lower-case `m` in "materials" — the ONE spelling on every client surface.
 *
 * The header PILL on both surfaces used to read capital-M `Time & Materials`, which put
 * `Time & Materials` directly above this cell's `Time & materials` the moment the summary
 * box shipped beneath it. Capital-M is RETIRED: both pills now call this helper
 * (`proposal-doc.tsx`, `proposal-pdf-document.tsx`), as do the accept modal's Total row
 * and the engagement terms strip. Do not reintroduce a hardcoded arm anywhere.
 */
export function pricingMethodLabel(method: ProposalReviewDoc['pricingMethod']): string {
  return method === 'fixed' ? 'Fixed price' : 'Time & materials';
}

/**
 * The summary box's top-row label. The old `Fixed price` total label is retired because
 * the PRICING cell below now carries the method.
 */
export function proposalTotalLabel(method: ProposalReviewDoc['pricingMethod']): string {
  return method === 'fixed' ? 'Total amount' : 'Estimated total';
}

/**
 * ⚠ NOT singularised: `timeframeWeeks === 1` renders `~1 weeks`. That is today's shipped
 * string on both surfaces; changing it is a copy change outside this ticket.
 */
function timelineValue(doc: ProposalReviewDoc): string {
  return doc.timeframeWeeks === null ? SUMMARY_EMPTY_VALUE : `~${doc.timeframeWeeks} weeks`;
}

function countedValue(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Fixed pricing: name the first tranche honestly. A literal "30% upfront" is a false
 * statement about when money changes hands whenever the first tranche is actually due on
 * completion, so the label is read rather than assumed — and when it is blank or too long
 * to hold one line, the cell falls back to the neutral count.
 */
function fixedPaymentValue(doc: ProposalReviewDoc): string {
  const [first] = doc.installments;
  if (first === undefined) return 'Due in full';

  const label = first.label.trim().toLowerCase();
  const composed = `${first.pct}% ${label}`;
  if (label.length === 0 || composed.length > PROPOSAL_SUMMARY_MAX_VALUE_CHARS) {
    return countedValue(doc.installments.length, 'payment');
  }
  return composed;
}

/**
 * T&M: both figures are nullable, so adapt to what exists. "Deposit + rate" on a proposal
 * carrying no deposit asserts money is due that isn't. The em-dash matches the TIMELINE
 * fallback so the two "not specified" states read alike.
 */
function timeAndMaterialsPaymentValue(doc: ProposalReviewDoc): string {
  const hasDeposit = doc.depositCents !== null;
  const hasRate = doc.rateCents !== null;
  if (hasDeposit && hasRate) return 'Deposit + rate';
  if (hasRate) return 'Rate only';
  if (hasDeposit) return 'Deposit only';
  return SUMMARY_EMPTY_VALUE;
}

function paymentValue(doc: ProposalReviewDoc): string {
  return doc.pricingMethod === 'fixed' ? fixedPaymentValue(doc) : timeAndMaterialsPaymentValue(doc);
}

function deliverablesValue(doc: ProposalReviewDoc): string {
  const count = doc.milestones.length;
  return count === 0 ? SUMMARY_EMPTY_VALUE : countedValue(count, 'item');
}

/** Exactly four cells, in the design reference's order. */
export function buildProposalSummaryCells(doc: ProposalReviewDoc): ProposalSummaryCell[] {
  return [
    { key: 'pricing', label: 'Pricing', value: pricingMethodLabel(doc.pricingMethod) },
    { key: 'timeline', label: 'Est. timeline', value: timelineValue(doc) },
    { key: 'payment', label: 'Payment', value: paymentValue(doc) },
    { key: 'deliverables', label: 'Deliverables', value: deliverablesValue(doc) },
  ];
}
