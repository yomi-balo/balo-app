import type { RecapView } from '@/lib/meetings/recap-view-types';
import { RecapLayout } from './recap-layout';

/** The EXPERT-lens payload — the union arm that has NO `resolve` field at all. */
type ExpertRecapView = Extract<RecapView, { lens: 'expert' }>;

/**
 * BAL-388 — the EXPERT composition.
 *
 * ⚠⚠ THIS MODULE MUST NEVER IMPORT THE RESOLVE PROMPT OR THE WRAP-UP CARD. That is the
 * STRUCTURAL proof of the acceptance criterion "the expert lens never shows the resolve
 * prompt": the branch is at COMPOSITION, so client-only copy is incapable of leaking through
 * a conditional bug. There is deliberately no `if (lens === expert)` anywhere in this feature.
 * A static SOURCE-SCAN test reads this file and fails if either name ever appears in it.
 *
 * The reason is a product rule, not tidiness: an expert can NEVER close a case (BAL-417 —
 * closing is client-only, because re-opening is out of scope, so a premature expert close
 * would fragment one issue across two cases and split its review). Rendering the offer to
 * someone the platform will refuse is a promise it cannot keep. The expert may only REQUEST
 * resolution, and that affordance is BAL-421's, on the case surface.
 *
 * Every other region is identical to the client lens, with §R3 and §R8 lens-swapped upstream
 * in the loader. That single sentence is the whole expert lens.
 */
export function ExpertRecap({ view }: Readonly<{ view: ExpertRecapView }>): React.JSX.Element {
  return <RecapLayout view={view} />;
}
