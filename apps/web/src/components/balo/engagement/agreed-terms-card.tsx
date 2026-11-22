'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { ChevronDown, Info, ScrollText } from 'lucide-react';
import { BaloCard } from '@/components/balo/card/balo-card';
import { BaloTermsBlock } from '@/components/balo/project-request/proposal/balo-terms-block';
import { NumberedList } from '@/components/balo/project-request/proposal/numbered-list';
import { track, ENGAGEMENT_EVENTS } from '@/lib/analytics';
import type { AgreedTermsView } from '@/lib/engagement/engagement-view';
import type { EngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import { cn } from '@/lib/utils';

interface AgreedTermsCardProps {
  view: AgreedTermsView;
  engagementId: string;
  lens: EngagementLens;
}

const SECTION_HEADING_CLASS = 'text-foreground text-[13.5px] font-semibold';

function ClauseSection({
  heading,
  items,
}: Readonly<{ heading: string; items: readonly string[] }>): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className={SECTION_HEADING_CLASS}>{heading}</h3>
      <NumberedList items={items} />
    </div>
  );
}

/**
 * "Agreed in the proposal": the assumptions, exclusions and additional terms snapshotted at
 * kickoff, read-only and the same on every lens. Collapsed until opened; the first open per
 * mount is tracked once. The card never carries money, so no lens sees a different figure.
 */
export function AgreedTermsCard({
  view,
  engagementId,
  lens,
}: Readonly<AgreedTermsCardProps>): React.JSX.Element {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const tracked = useRef(false);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => !wasOpen);
    if (tracked.current) return;
    tracked.current = true;
    track(ENGAGEMENT_EVENTS.AGREED_TERMS_OPENED, { engagement_id: engagementId, lens });
  }, [engagementId, lens]);

  return (
    <BaloCard as="section" aria-label="Agreed in the proposal">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="hover:bg-muted/40 focus-visible:ring-ring flex min-h-11 w-full items-center gap-3 rounded-2xl p-4 text-left focus-visible:ring-2 focus-visible:outline-none sm:px-6"
      >
        <span className="border-border bg-muted/40 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
          <ScrollText className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-foreground block text-sm font-semibold">
            Agreed in the proposal
          </span>
          <span className="text-muted-foreground block text-xs">{view.summary}</span>
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            open && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </button>

      <div id={bodyId} hidden={!open}>
        <div className="border-border flex flex-col gap-5 border-t p-4 sm:px-6 sm:py-5">
          {view.acceptedLine !== null && (
            <p className="text-muted-foreground text-[13px]">{view.acceptedLine}</p>
          )}
          {view.changedSinceStart && (
            <div className="border-border bg-muted/30 flex items-start gap-2.5 rounded-xl border px-3.5 py-3">
              <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p className="text-foreground text-[13px] leading-relaxed">
                This is what was agreed at the start. Changes approved since then are under “Changes
                to this project”.
              </p>
            </div>
          )}
          <ClauseSection heading="Assumptions" items={view.assumptions} />
          <ClauseSection heading="Not included" items={view.exclusions} />
          <ClauseSection
            heading={`${view.expertName}’s additional terms`}
            items={view.additionalTerms}
          />
          <div className="flex flex-col gap-2">
            <h3 className={SECTION_HEADING_CLASS}>Balo’s terms</h3>
            <BaloTermsBlock
              pricingMethod={view.pricingMethod}
              companyName={view.clientCompanyName}
              where="accept"
            />
          </div>
        </div>
      </div>
    </BaloCard>
  );
}
