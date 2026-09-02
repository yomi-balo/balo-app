'use client';

import { CardBrandMark, formatCardBrand } from './CardBrandMark';
import { formatCardExpiry } from '@/lib/credit/display-constants';
import type { SavedCard } from './types';

interface SavedCardRowProps {
  readonly card: SavedCard;
  /** Swap to the Payment Element to enter a different card. */
  readonly onChange: () => void;
}

/** "Visa •••• 4242" — the one string both this row and the summary rail's line use. */
export function describeSavedCard(card: SavedCard): string {
  return `${formatCardBrand(card.brand)} •••• ${card.last4}`;
}

/**
 * The card a returning buyer already gave us. Renders INSTEAD of the Stripe Payment Element on
 * the common path, so nobody re-types a card we hold — and no Stripe iframe is loaded for a
 * purchase that does not need one.
 *
 * "Change" is a real button (44px tap target via the padded hit area), not a link: it mounts the
 * Payment Element beside this row. It never unmounts anything.
 */
export function SavedCardRow({ card, onChange }: Readonly<SavedCardRowProps>) {
  return (
    <div className="border-border bg-card flex items-center gap-3 rounded-xl border p-3.5">
      <CardBrandMark brand={card.brand} />
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm font-semibold">{describeSavedCard(card)}</div>
        <div className="text-muted-foreground mt-0.5 text-xs font-medium">
          Expires {formatCardExpiry(card.expMonth, card.expYear)}
        </div>
      </div>
      <button
        type="button"
        onClick={onChange}
        className="text-primary focus-visible:ring-ring relative rounded text-sm font-semibold before:absolute before:-inset-3 before:content-[''] hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
      >
        Change
      </button>
    </div>
  );
}
