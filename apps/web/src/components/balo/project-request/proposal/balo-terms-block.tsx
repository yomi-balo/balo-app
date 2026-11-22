'use client';

import { useId, useState } from 'react';
import { Lock } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { STANDARD_TERMS, pricingMethodRule } from './proposal-standard-terms';

interface BaloTermsBlockProps {
  pricingMethod: 'fixed' | 'tm';
  companyName: string;
  /**
   * Who is reading. The composer talks to the expert; the proposal and the accept dialog
   * talk to the client. Only `proposal` carries the collapsible "In short" summary.
   */
  where: 'composer' | 'proposal' | 'accept';
}

/** The framing line under the title, or null when the surface wants none. */
function subline(where: BaloTermsBlockProps['where']): string | null {
  if (where === 'composer') {
    return 'They cover every project on Balo and can’t be changed for one project.';
  }
  if (where === 'proposal') return 'The same terms for every project on Balo.';
  return null;
}

/**
 * The Balo Project T&Cs block: what every project on Balo is bound by, plus Balo's rule
 * for how a cost increase is handled under the proposal's pricing method. One component for
 * the composer, the proposal document, the accept dialog and the delivery card.
 */
export function BaloTermsBlock({
  pricingMethod,
  companyName,
  where,
}: Readonly<BaloTermsBlockProps>): React.JSX.Element {
  const summaryId = useId();
  const [open, setOpen] = useState(false);
  const sub = subline(where);

  return (
    <div className="border-border bg-muted/30 flex items-start gap-3 rounded-xl border px-4 py-3">
      <span className="border-border bg-card flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border">
        <Lock className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-[13.5px] font-semibold">
          {where === 'accept' ? 'Balo Project T&Cs' : 'Balo Project T&Cs apply'}
        </p>
        {sub !== null && <p className="text-muted-foreground mt-px text-xs">{sub}</p>}
        <p className="text-foreground mt-1.5 text-[13px] leading-relaxed">
          {pricingMethodRule(pricingMethod, companyName)}
        </p>
        {where === 'proposal' && (
          <Collapsible open={open} onOpenChange={setOpen} className="mt-1">
            <CollapsibleTrigger
              aria-controls={summaryId}
              className="text-primary focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
            >
              {open ? 'Hide summary' : 'In short'}
            </CollapsibleTrigger>
            <CollapsibleContent id={summaryId}>
              <ul className="text-muted-foreground flex list-disc flex-col gap-1.5 pb-1 pl-5 text-xs leading-relaxed">
                {STANDARD_TERMS.map((term) => (
                  <li key={term}>{term}</li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
}
