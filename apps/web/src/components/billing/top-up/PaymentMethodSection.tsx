'use client';

import { useCallback, useState } from 'react';
import { PaymentElement } from '@stripe/react-stripe-js';
import { Lock } from 'lucide-react';
import { SavedCardRow, describeSavedCard } from './SavedCardRow';
import type { SavedCard } from './types';
import type { PaymentMethodSource } from '@/lib/credit/api-client';

interface PaymentMethodSectionProps {
  readonly savedCard: SavedCard | null;
  readonly source: PaymentMethodSource;
  readonly onSourceChange: (source: PaymentMethodSource) => void;
}

/**
 * Payment method — a saved-card row ⇄ the Stripe Payment Element, swapped IN PLACE.
 *
 * ⚠ THE ELEMENT IS LAZY-MOUNTED AND THEN NEVER UNMOUNTED. This is the load-bearing rule of the
 * whole component, verified against the shipped `@stripe/react-stripe-js@6.8.0` bundle
 * (`dist/react-stripe.umd.js:666-676`): unmounting `<PaymentElement>` runs a `useLayoutEffect`
 * cleanup that calls `element.destroy()`, and there is no re-mount path — the next mount runs
 * `elements.create()` afresh. So an unmount throws away whatever the buyer has typed,
 * permanently.
 *
 * The rule in code:
 *  · `elementRequested` starts `true` when there is no saved card (mount immediately, as today)
 *    and `false` when there is one (no wasted Stripe iframe on the common path).
 *  · It latches `true` the moment `source` becomes `'new_card'`. NOTHING sets it back to `false`.
 *  · "Keep •••• 4242 instead" flips `source` only; the Element's wrapper gets the HTML `hidden`
 *    attribute, which removes it from layout AND from the accessibility tree while keeping the
 *    live element — and its digits — intact.
 *
 * ⚠ THE LATCH IS DRIVEN BY THE `source` PROP, NOT BY THIS COMPONENT'S OWN BUTTON. There are TWO
 * ways into the new-card path and only one of them passes through here: the "Change" button, and
 * `PayAction`'s post-decline "Use a different card" escape, which calls the composer directly.
 * When the latch was set only by the local button, that second route hid the saved-card row
 * (`source` changed) without ever mounting the Element — leaving the buyer with a heading and no
 * card input anywhere, unrecoverable without a reload. Deriving it from `source` closes that by
 * construction: any route to `'new_card'` mounts the Element.
 *
 * The latch is applied DURING RENDER (React's supported "adjust state when a prop changes"
 * pattern) rather than in an effect, so the Element mounts in the SAME commit that hides the
 * saved-card row — there is never a painted frame with neither on screen.
 *
 * NEVER write `{!useSavedCard && <PaymentElement/>}`, never add a `key`, never move it under a
 * conditional parent. All three unmount.
 */
export function PaymentMethodSection({
  savedCard,
  source,
  onSourceChange,
}: Readonly<PaymentMethodSectionProps>) {
  const [elementRequested, setElementRequested] = useState(
    savedCard === null || source === 'new_card'
  );
  const [elementReady, setElementReady] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // One-way latch — see the docblock. Requesting the Element can never be undone.
  if (source === 'new_card' && !elementRequested) {
    setElementRequested(true);
  }

  const showSaved = savedCard !== null && source === 'saved_card';

  const handleChange = useCallback(() => onSourceChange('new_card'), [onSourceChange]);

  const handleKeepSaved = useCallback(() => onSourceChange('saved_card'), [onSourceChange]);
  const handleReady = useCallback(() => setElementReady(true), []);
  const handleLoadError = useCallback(() => setLoadError(true), []);

  return (
    <div>
      <div className="text-foreground mb-2.5 text-sm font-semibold">Payment method</div>

      {showSaved && <SavedCardRow card={savedCard} onChange={handleChange} />}

      {/* Always rendered once requested; `hidden` (not unmounted) while the saved card is used. */}
      <div hidden={showSaved}>
        <p className="text-muted-foreground mb-2.5 flex items-center gap-1.5 text-xs font-medium">
          <Lock className="size-3" strokeWidth={2.4} aria-hidden="true" />
          Entered directly with Stripe — Balo never sees your card number.
        </p>

        {elementRequested && !loadError && !elementReady && (
          <div className="space-y-3" data-testid="payment-element-skeleton">
            <span className="bg-muted/50 block h-11 w-full animate-pulse rounded-md" />
            <div className="flex gap-3">
              <span className="bg-muted/50 block h-11 flex-1 animate-pulse rounded-md" />
              <span className="bg-muted/50 block h-11 flex-1 animate-pulse rounded-md" />
            </div>
            <span className="sr-only">Loading the card form…</span>
          </div>
        )}

        {loadError && (
          <p role="alert" className="text-destructive text-sm font-medium">
            We couldn&apos;t load the card form. Refresh and try again.
          </p>
        )}

        {elementRequested && (
          <div hidden={loadError}>
            <PaymentElement onReady={handleReady} onLoadError={handleLoadError} />
          </div>
        )}

        {savedCard !== null && (
          <div className="mt-2.5">
            <button
              type="button"
              onClick={handleKeepSaved}
              className="text-muted-foreground focus-visible:ring-ring relative rounded text-sm font-semibold before:absolute before:-inset-3 before:content-[''] hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
            >
              Keep {describeSavedCard(savedCard)} instead
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
