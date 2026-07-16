import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { formatUtcLongDate } from '@/lib/format/local-date';

interface SharedProposalBannerProps {
  status: string;
  clientCompany: string;
  expertOrg: string;
  acceptedOnIso: string | null;
}

/**
 * State banner on the public shared proposal (BAL-386). `accepted` → green (with the
 * accepted date as a helpful fact); `withdrawn` → amber, framed for reference only;
 * any other status renders nothing. Copy is retrospective and non-adversarial.
 */
export function SharedProposalBanner({
  status,
  clientCompany,
  expertOrg,
  acceptedOnIso,
}: Readonly<SharedProposalBannerProps>): React.JSX.Element | null {
  if (status === 'accepted') {
    const on = acceptedOnIso === null ? '' : ` on ${formatUtcLongDate(acceptedOnIso)}`;
    return (
      <div className="border-success/30 bg-success/10 flex items-center gap-2.5 border-b px-5 py-3 sm:px-6">
        <CheckCircle2 className="text-success h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-foreground text-[13px]">
          This proposal was accepted by {clientCompany}
          {on}.
        </p>
      </div>
    );
  }

  if (status === 'withdrawn') {
    return (
      <div className="border-warning/30 bg-warning/10 flex items-center gap-2.5 border-b px-5 py-3 sm:px-6">
        <AlertCircle className="text-warning h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-foreground text-[13px]">
          This proposal has been withdrawn by {expertOrg}. It&apos;s shown here for reference only.
        </p>
      </div>
    );
  }

  return null;
}
