/**
 * Maps composer state onto the read-only `ProposalReviewDoc` for the full-page
 * preview (BAL-610). Pure and client-safe. It maps the output of `toSavePayload`,
 * so the preview shows exactly what Send submits. Money is the expert's own quote
 * (identity pricing): the Balo fee is never applied here and `adminPricing` is
 * never set, so no client-side (marked-up) figure can render.
 */

import type { ProposalExpertIdentity, ProposalReviewDoc } from './proposal-review-types';
import { toSavePayload, type ProposalDraftState } from './proposal-composer-state';

export interface DraftPreviewContext {
  requestId: string;
  relationshipId: string;
  version: number;
  expert: ProposalExpertIdentity;
}

export function draftToReviewDoc(
  state: ProposalDraftState,
  ctx: DraftPreviewContext
): ProposalReviewDoc {
  const payload = toSavePayload(state, ctx.requestId, ctx.relationshipId);
  return {
    id: state.proposalId ?? 'draft-preview',
    relationshipId: ctx.relationshipId,
    version: ctx.version,
    status: 'draft',
    pricingMethod: payload.pricingMethod,
    overviewHtml: payload.overview,
    exclusionsHtml: payload.exclusions ?? null,
    priceCents: payload.priceCents,
    currency: payload.currency ?? state.currency,
    timeframeWeeks: payload.timeframeWeeks ?? null,
    depositCents: payload.depositCents ?? null,
    rateCents: payload.rateCents ?? null,
    cadence: payload.cadence ?? null,
    milestones: state.milestones.map((m, i) => {
      const saved = payload.milestones[i];
      return {
        id: m.key,
        title: m.title,
        descriptionHtml: saved?.descriptionHtml ?? null,
        acceptanceCriteria: saved?.acceptanceCriteria ?? null,
        valueCents: saved?.valueCents ?? null,
      };
    }),
    installments:
      payload.pricingMethod === 'fixed'
        ? state.installments.map((i) => ({ id: i.key, label: i.label, pct: i.pct }))
        : [],
    attachments: state.documents.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      sizeBytes: d.sizeBytes,
      kind: d.kind,
    })),
    expert: ctx.expert,
  };
}
