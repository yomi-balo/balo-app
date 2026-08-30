import { Eye } from 'lucide-react';
import { Logo } from '@/components/layout/logo';

interface SharedProposalHeaderProps {
  sharerName: string;
  clientCompany: string;
}

/**
 * Dark gradient provenance strip atop the public shared proposal (BAL-386). States
 * who shared it (retrospective person "@ company") and that the view is read-only.
 */
export function SharedProposalHeader({
  sharerName,
  clientCompany,
}: Readonly<SharedProposalHeaderProps>): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-gradient-to-br from-slate-900 to-slate-800 px-5 py-3.5 sm:px-6">
      <div className="flex items-center gap-3">
        {/* `variant="dark"` is pinned, not theme-following: this header is a slate gradient in
            BOTH themes, so the light (navy) mark would disappear into it for a light-mode
            reader. `asLink` is off — the recipient is an unauthenticated guest holding a share
            token, and a link to `/` is not where they are trying to go. */}
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
          <Logo asLink={false} iconOnly variant="dark" height={18} />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-white">Shared proposal</p>
          <p className="truncate text-xs text-white/60">
            Shared with you by {sharerName} at {clientCompany}
          </p>
        </div>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white/85">
        <Eye className="h-3 w-3" aria-hidden="true" />
        View only
      </span>
    </div>
  );
}
