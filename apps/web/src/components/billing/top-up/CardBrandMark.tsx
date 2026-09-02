'use client';

import { CreditCard } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CardBrandMarkProps {
  /** Stripe's raw brand string, e.g. 'visa', 'mastercard', 'amex', 'unknown'. */
  readonly brand: string;
  readonly className?: string;
}

/** Brands whose short name reads clearly in a 40px chip; anything else falls back to a glyph. */
const BRAND_LABEL: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'MC',
  amex: 'Amex',
  discover: 'Disc',
  diners: 'Diners',
  jcb: 'JCB',
  unionpay: 'UP',
  eftpos_au: 'Eftpos',
};

/** Title-case a raw Stripe brand for prose ("visa" → "Visa"), leaving known labels alone. */
export function formatCardBrand(brand: string): string {
  const known = BRAND_LABEL[brand.toLowerCase()];
  if (known !== undefined) return known === 'MC' ? 'Mastercard' : known;
  const [first, ...rest] = brand;
  if (first === undefined) return 'Card';
  return first.toUpperCase() + rest.join('');
}

/**
 * A token-based card-brand chip.
 *
 * ⚠ DELIBERATELY NOT the network logos. Hand-rolled approximations of the Visa / Mastercard /
 * Amex marks (as the prototype draws them) are a brand-guideline risk, hardcode raw hex in
 * violation of balo-ui, and are illegible in dark mode. A muted chip carrying the brand name —
 * or a Lucide glyph for a brand with no short label — says the same thing and themes correctly.
 * Revisit only with real, licensed network marks.
 */
export function CardBrandMark({ brand, className }: Readonly<CardBrandMarkProps>) {
  const label = BRAND_LABEL[brand.toLowerCase()];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-muted text-muted-foreground border-border flex h-[22px] w-9 shrink-0 items-center justify-center rounded border',
        className
      )}
    >
      {label === undefined ? (
        <CreditCard className="size-3.5" strokeWidth={2.2} />
      ) : (
        <span className="text-[10px] font-bold tracking-wide uppercase">{label}</span>
      )}
    </span>
  );
}
