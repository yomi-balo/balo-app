'use client';

import { Clock, CreditCard, Gift, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TopUpHero } from './TopUpHero';
import { formatAud, formatIndicative, timeStr } from '@/lib/credit/display-constants';
import type { DisplayFxSnapshot } from './types';

interface SummaryRailProps {
  readonly amountMinor: number;
  readonly promoMinor: number;
  readonly promoCode: string | null;
  readonly fx: DisplayFxSnapshot | null;
  /** "Visa •••• 4242" or "New card" — what the buyer is about to be charged on. */
  readonly payingWith: string;
  /** The Pay button, injected so the rail stays presentational and Stripe-free. */
  readonly payAction: React.ReactNode;
}

interface SummaryLineProps {
  readonly label: string;
  readonly value: string;
  readonly icon?: LucideIcon;
  readonly strong?: boolean;
  readonly positive?: boolean;
  /** A secondary figure under the value — the indicative local-currency estimate. */
  readonly sub?: string | null;
}

function SummaryLine({
  label,
  value,
  icon: Icon,
  strong = false,
  positive = false,
  sub = null,
}: Readonly<SummaryLineProps>) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[13px] font-medium">
        {Icon && <Icon className="size-3.5" strokeWidth={2.3} aria-hidden="true" />}
        {label}
      </span>
      <span className="text-right">
        <span
          className={cn(
            'block tabular-nums',
            strong ? 'text-[15px] font-bold' : 'text-[13px] font-semibold',
            positive ? 'text-success' : 'text-foreground'
          )}
        >
          {value}
        </span>
        {sub !== null && (
          <span className="text-muted-foreground block text-xs font-medium">{sub}</span>
        )}
      </span>
    </div>
  );
}

/**
 * The sticky summary rail — hero, totals, and Pay, so the argument for paying never scrolls
 * away from the button that does it. The left column can be as long as first-time card capture
 * needs; nobody arrives at Pay having scrolled past the reason to pay.
 *
 * Presentational: the Pay button is passed in as `payAction` because it must live inside
 * `<Elements>` (hoisted to the composer root) while this component must not depend on Stripe.
 */
export function SummaryRail({
  amountMinor,
  promoMinor,
  promoCode,
  fx,
  payingWith,
  payAction,
}: Readonly<SummaryRailProps>) {
  const creditedMinor = amountMinor + promoMinor;
  const hasPromo = promoMinor > 0 && promoCode !== null;

  return (
    <div className="border-border bg-card overflow-hidden rounded-2xl border shadow-lg">
      <TopUpHero amountMinor={amountMinor} promoMinor={promoMinor} fx={fx} />

      <div className="px-5 pt-3.5 pb-5">
        <SummaryLine
          label="Top-up"
          value={formatAud(amountMinor)}
          sub={fx ? `≈ ${formatIndicative(amountMinor, fx.currency, fx.audToQuote)}` : null}
        />
        {hasPromo && (
          <>
            <SummaryLine
              icon={Gift}
              label={`${promoCode} bonus`}
              value={`+${formatAud(promoMinor)}`}
              positive
            />
            <SummaryLine label="Credited to wallet" value={formatAud(creditedMinor)} strong />
          </>
        )}
        <SummaryLine icon={CreditCard} label="Paying with" value={payingWith} />

        <div className="bg-border/60 my-3 h-px" />

        <p className="text-muted-foreground mb-3 flex items-center gap-1.5 text-[13px] font-semibold">
          <Clock className="size-3.5" strokeWidth={2.3} aria-hidden="true" /> Buys ≈{' '}
          {timeStr(creditedMinor)}
        </p>

        {payAction}

        <p className="text-muted-foreground mt-2.5 text-center text-[11px] leading-relaxed font-medium">
          {fx
            ? `You'll be charged approximately ${formatIndicative(amountMinor, fx.currency, fx.audToQuote)} in your local currency — the final amount is set at payment.`
            : "You'll be charged in AUD — your bank sets the final rate."}
        </p>
        {/*
          R17's substitute for the deleted Invoice/transfer tile. "Talk to us" is an imperative,
          so it has to go somewhere — a buyer who needs invoice billing and clicks dead text is
          worse off than one who was never offered the option. `mailto:` is the affordance the
          rest of the app uses for support (reset-password-form, expert settings).
        */}
        <p className="text-muted-foreground mt-1.5 text-center text-[11px] leading-relaxed font-medium">
          Paying by invoice or bank transfer?{' '}
          <a
            href="mailto:support@getbalo.com?subject=Paying%20by%20invoice%20or%20bank%20transfer"
            className="text-foreground focus-visible:ring-ring rounded font-semibold underline underline-offset-2 hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
          >
            Talk to us
          </a>
          {'.'}
        </p>
      </div>
    </div>
  );
}
