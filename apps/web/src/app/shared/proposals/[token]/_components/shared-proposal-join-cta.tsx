import Link from 'next/link';
import { UserPlus } from 'lucide-react';

interface SharedProposalJoinCtaProps {
  clientCompany: string;
}

/**
 * Domain-matched Join CTA on the public shared proposal (BAL-386). Shown only when
 * the recipient's email domain matches the client company's verified `party_domain`
 * (ADR-1031 auto-join) and the proposal isn't withdrawn — gate resolved by the page.
 */
export function SharedProposalJoinCta({
  clientCompany,
}: Readonly<SharedProposalJoinCtaProps>): React.JSX.Element {
  return (
    <div className="border-primary/20 bg-primary/[0.06] mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4">
      <div className="flex items-center gap-3">
        <span className="border-border bg-card flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border">
          <UserPlus className="text-primary h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-foreground text-[13.5px] font-semibold">Work at {clientCompany}?</p>
          <p className="text-muted-foreground text-[12.5px]">
            Join your team on Balo to comment on and act on proposals.
          </p>
        </div>
      </div>
      <Link
        href="/signup"
        className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-[13.5px] font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
      >
        Join {clientCompany} on Balo
      </Link>
    </div>
  );
}
