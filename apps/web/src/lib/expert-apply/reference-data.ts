import 'server-only';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { log } from '@/lib/logging';
import {
  referenceDataRepository,
  type ProductsByCategory,
  type CertificationsByCategory,
  type Vertical,
  type SupportType,
  type Language,
  type Industry,
} from '@balo/db';

/**
 * BAL-502 §22 — the public Salesforce taxonomy used by the expert-application wizard.
 * Six catalogue reads, none user-scoped (vertical, products, support types,
 * certifications, languages, industries). This is the ONE definition — both the
 * anonymous branch of `(apply)/expert/apply/page.tsx` and the authenticated
 * `loadDraftAction` (`_actions/load-draft.ts`) compose this function rather than
 * duplicating the six repository calls.
 */
export interface ReferenceData {
  productsByCategory: ProductsByCategory[];
  supportTypes: SupportType[];
  certificationsByCategory: CertificationsByCategory[];
  languages: Language[];
  industries: Industry[];
  vertical: Vertical;
}

/**
 * A plain async server function — deliberately NOT a Server Action (`'use server'`
 * exports are publicly POSTable endpoints, and this data is read straight from a
 * server component render, so an action would open an anonymous-callable surface
 * for no gain). The products/support-types/certifications reads need the vertical
 * id first, so the vertical is resolved before the remaining five run in parallel.
 */
async function fetchReferenceData(): Promise<ReferenceData> {
  const vertical = await referenceDataRepository.getSalesforceVertical();

  const [productsByCategory, supportTypes, certificationsByCategory, languages, industries] =
    await Promise.all([
      referenceDataRepository.getProductsByVertical(vertical.id),
      referenceDataRepository.getSupportTypes(vertical.id),
      referenceDataRepository.getCertificationsByVertical(vertical.id),
      referenceDataRepository.getLanguages(),
      referenceDataRepository.getIndustries(),
    ]);

  return {
    productsByCategory,
    supportTypes,
    certificationsByCategory,
    languages,
    industries,
    vertical,
  };
}

/**
 * BAL-502 FIX round (security phase) — `/expert/apply` went from an Edge-only 307 (zero DB
 * work) to a full RSC render, and this function alone issues six catalogue reads. None of it
 * is user-scoped (Salesforce taxonomy: vertical, products, support types, certifications,
 * languages, industries) and it changes on the order of months, so it is cached at two layers:
 *   - `unstable_cache` — a cross-request cache, revalidated once a day. The wrapped function
 *     takes no arguments and reads only public data, so ONE cache entry is correct for every
 *     visitor, signed in or not.
 *   - `cache()` (React) — a per-request dedup on top, so the authenticated path
 *     (`loadDraftAction` in `_actions/load-draft.ts`) and the anonymous branch of
 *     `(apply)/expert/apply/page.tsx` never issue two lookups in the same render.
 *
 * ⚠ `unstable_cache` requires Next's request-scoped incremental-cache handler, which exists
 * only inside a real Next.js server request — NOT in a plain Node/vitest process. Every
 * existing caller of `loadReferenceData` composes it directly (there is no seam to mock this
 * module away in, say, `load-draft.test.ts`, which mocks only the `@balo/db` repository), so a
 * bare `unstable_cache` call would throw `Invariant: incrementalCache missing` in every one of
 * those tests. The try/catch below falls back to the uncached read when that happens — this is
 * a real, if rare, production hazard too (a misconfigured cache handler should degrade to a
 * live read, not break the page), not merely a test-environment workaround.
 */
const getDailyCachedReferenceData = unstable_cache(
  fetchReferenceData,
  ['expert-apply-reference-data'],
  { revalidate: 60 * 60 * 24, tags: ['expert-apply-reference-data'] }
);

export const loadReferenceData: () => Promise<ReferenceData> = cache(
  async (): Promise<ReferenceData> => {
    try {
      return await getDailyCachedReferenceData();
    } catch (error) {
      log.warn('unstable_cache unavailable for expert-apply reference data; reading uncached', {
        error: error instanceof Error ? error.message : String(error),
      });
      return fetchReferenceData();
    }
  }
);
