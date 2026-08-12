import type { RecapView } from '@/lib/meetings/recap-view-types';
import { RecapLayout } from './recap-layout';
import { ResolveDismissalProvider } from './resolve-dismissal';
import { ResolvePromptBanner } from './resolve-prompt-banner';
import { WrapUpCard } from './wrap-up-card';

/** The CLIENT-lens payload — the union arm that carries `resolve`. */
type ClientRecapView = Extract<RecapView, { lens: 'client' }>;

/**
 * BAL-388 — the CLIENT composition. THE ONLY MODULE IN THIS FEATURE THAT REFERENCES §R4
 * banner or §R9 wrap-up card.
 *
 * ⚠ R4 AND R9 ARE MUTUALLY EXCLUSIVE, AND THE EXCLUSION IS DECIDED SERVER-SIDE by
 * `resolve.variant`: `requested` fills the banner (the expert asked — louder, and attributed),
 * `offered` fills the quieter rail card, `none` fills neither — except once the case is CLOSED,
 * when the rail card stays to state the outcome in place.
 *
 * ⚠⚠ THE PROVIDER IS MOUNTED HERE, ABOVE BOTH SLOTS, AND IT HAS TO BE. Dismissing the R4
 * banner clears the request columns server-side, so the very next render reports
 * `variant: 'offered'` and `showWrapUp` below flips TRUE — the page would ask the client the
 * question they just declined, two inches lower. `ResolveDismissalProvider` survives the
 * `router.refresh()` that swaps the banner out for the card, and `UnlessDismissed` inside the
 * layout suppresses the slot (wrapper included) for the rest of the session.
 *
 * ⚠⚠ THE SLOTS ARE PASSED AS `undefined` WHEN THEY WOULD RENDER NOTHING. Handing the layout
 * a component that returns `null` still leaves an empty `Reveal` as a grid child, i.e. a dead
 * 16-24px gap above the grid and another between the party card and Files — including
 * immediately after resolving, which is the worst possible moment for the rail to look broken.
 * Both components ALSO return `null` for a variant that is not theirs, so the page can never
 * ask the same question twice.
 */
export function ClientRecap({ view }: Readonly<{ view: ClientRecapView }>): React.JSX.Element {
  const { resolve } = view;
  const showBanner = resolve.variant === 'requested';
  const showWrapUp = resolve.variant === 'offered' || resolve.resolved !== null;

  return (
    <ResolveDismissalProvider>
      <RecapLayout
        view={view}
        banner={
          showBanner ? (
            <ResolvePromptBanner meetingId={view.meetingId} resolve={resolve} />
          ) : undefined
        }
        wrapUp={
          showWrapUp ? <WrapUpCard meetingId={view.meetingId} resolve={resolve} /> : undefined
        }
      />
    </ResolveDismissalProvider>
  );
}
