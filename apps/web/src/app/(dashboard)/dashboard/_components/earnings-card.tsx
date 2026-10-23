import { BaloCard } from '@/components/balo/card/balo-card';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

const EARNINGS_LINES = [
  { label: 'Pending transfer', value: 'A$0.00' },
  { label: 'This payout cycle', value: 'A$0.00' },
  { label: 'Total earnings', value: 'A$0.00' },
] as const;

const PAYOUTS_HREF = '/expert/settings?tab=payouts';

/** Placeholder earnings summary: the figures are static until an earnings read exists. */
export function EarningsCard(): React.JSX.Element {
  return (
    <BaloCard as="section" aria-labelledby="earnings-heading" className="px-[18px] pt-[18px]">
      <h2
        id="earnings-heading"
        className="text-foreground text-[15px] font-semibold tracking-tight"
      >
        Earnings
      </h2>
      <dl className="mt-2.5">
        {EARNINGS_LINES.map((line) => (
          <div
            key={line.label}
            className="border-border flex items-baseline justify-between border-b py-[9px]"
          >
            <dt className="text-muted-foreground text-[13px]">{line.label}</dt>
            <dd className="text-foreground text-sm font-semibold tabular-nums">{line.value}</dd>
          </div>
        ))}
      </dl>
      <div className="pt-3 pb-2.5">
        <Link
          href={PAYOUTS_HREF}
          className="text-primary focus-visible:ring-ring inline-flex min-h-11 items-center gap-1 rounded-sm text-[12.5px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          View payouts
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </div>
    </BaloCard>
  );
}
