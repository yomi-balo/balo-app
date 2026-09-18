import type { CasesIndexTarget } from '@balo/analytics/events';
import type { CasesIndexCardView } from '../_lib/cases-index-view-types';

/**
 * BAL-567 — how a surface reports a click, WITHOUT importing the analytics client itself.
 *
 * ⚠⚠ THE ISLANDS TAKE A REPORTER RATHER THAN CALLING `track` DIRECTLY, so
 * `RECAP_EVENTS.CASES_INDEX_CLICKED` is emitted from exactly ONE place
 * (`cases-index-shell.tsx`). That is what keeps `card_state` honest: the shell resolves it AT
 * CLICK TIME — including a `live` the viewer's clock produced a moment ago — rather than each
 * card reporting whatever the server stamped on it.
 *
 * ⚠ TWO TYPES, ONE REPORTER. The shell's reporter takes the card; a card BINDS ITSELF once (in a
 * `useCallback`) and hands its children the card-free {@link CasesIndexClickHandler}, so no
 * handler identity changes on a re-render and no child has to carry the whole card around just
 * to report a click.
 *
 * Types only — no runtime import, so this adds nothing to any bundle.
 */

/** `card` is `null` for a target that belongs to no card (the header CTA, a resolved row). */
export type CasesIndexClickReporter = (
  target: CasesIndexTarget,
  card: CasesIndexCardView | null
) => void;

/** A reporter with its card already bound. */
export type CasesIndexClickHandler = (target: CasesIndexTarget) => void;
