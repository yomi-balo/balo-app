'use client';

import { useId, useState } from 'react';
import { ExternalLink, Lock } from 'lucide-react';
import type {
  ProjectTermsLens,
  ProjectTermsOpenSurface,
  ProjectTermsPdfSurface,
} from '@balo/analytics/events';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { TermsPdfLink } from '@/components/balo/legal/terms-pdf-link';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatTermsDate } from '@/lib/legal/terms';
import { PROJECT_TERMS_PAGE_PATH, projectTermsPdfHref } from '@/lib/legal/project-terms-versions';
import { STANDARD_TERMS, pricingMethodRule } from './proposal-standard-terms';

type TermsBlockWhere = 'composer' | 'proposal' | 'shared' | 'accept' | 'delivery';

interface BaloTermsBlockProps {
  pricingMethod: 'fixed' | 'tm';
  companyName: string;
  /**
   * Which surface renders the block. The composer talks to the expert; the proposal, the shared
   * page and the accept dialog talk to the client. Only `proposal` and `shared` carry the
   * collapsible "In short" summary.
   */
  where: TermsBlockWhere;
  /** Who is reading, for the terms-opened event. */
  lens: ProjectTermsLens;
  /**
   * Present once the proposal is accepted. `termsVersion` is the version recorded at
   * acceptance, or null when it was accepted before versions were recorded.
   */
  acceptance?: { termsVersion: string | null };
}

interface SurfaceConfig {
  title: string;
  subline: string | null;
  inShort: boolean;
  openSurface: ProjectTermsOpenSurface;
  pdfSurface: ProjectTermsPdfSurface | null;
}

const COMPOSER_SUBLINE = 'They cover every project on Balo and can’t be changed for one project.';
const PROPOSAL_SUBLINE = 'The same terms for every project on Balo.';

const SURFACES: Record<TermsBlockWhere, SurfaceConfig> = {
  composer: {
    title: 'Balo Project T&Cs apply',
    subline: COMPOSER_SUBLINE,
    inShort: false,
    openSurface: 'composer',
    pdfSurface: null,
  },
  proposal: {
    title: 'Balo Project T&Cs apply',
    subline: PROPOSAL_SUBLINE,
    inShort: true,
    openSurface: 'proposal',
    pdfSurface: 'proposal',
  },
  shared: {
    title: 'Balo Project T&Cs apply',
    subline: PROPOSAL_SUBLINE,
    inShort: true,
    openSurface: 'shared',
    pdfSurface: 'shared',
  },
  accept: {
    title: 'Balo Project T&Cs',
    subline: null,
    inShort: false,
    openSurface: 'accept_dialog',
    pdfSurface: null,
  },
  delivery: {
    title: 'Balo Project T&Cs',
    subline: null,
    inShort: false,
    openSurface: 'delivery',
    pdfSurface: 'delivery',
  },
};

const LINK_CLASS =
  'text-primary focus-visible:ring-ring inline-flex min-h-11 items-center gap-1 rounded-md text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none';

/**
 * The Balo Project T&Cs block: what every project on Balo is bound by, plus Balo's rule
 * for how a cost increase is handled under the proposal's pricing method. One component for
 * the composer, the proposal document, the shared page, the accept dialog and the delivery
 * card. Links to the public terms page, or, on an accepted proposal, to the PDF of the
 * version that was accepted.
 */
export function BaloTermsBlock({
  pricingMethod,
  companyName,
  where,
  lens,
  acceptance,
}: Readonly<BaloTermsBlockProps>): React.JSX.Element {
  const summaryId = useId();
  const [open, setOpen] = useState(false);
  const config = SURFACES[where];

  const acceptedVersion = acceptance?.termsVersion ?? null;
  const pdfHref = acceptedVersion === null ? null : projectTermsPdfHref(acceptedVersion);
  const pdf =
    acceptedVersion !== null && pdfHref !== null && config.pdfSurface !== null
      ? { href: pdfHref, version: acceptedVersion, surface: config.pdfSurface }
      : null;

  const handleOpened = (): void => {
    track(PROJECT_EVENTS.PROJECT_TERMS_OPENED, { surface: config.openSurface, lens });
  };

  return (
    <div className="border-border bg-muted/30 flex items-start gap-3 rounded-xl border px-4 py-3">
      <span className="border-border bg-card flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border">
        <Lock className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-[13.5px] font-semibold">{config.title}</p>
        {config.subline !== null && (
          <p className="text-muted-foreground mt-px text-xs">{config.subline}</p>
        )}
        <p className="text-foreground mt-1.5 text-[13px] leading-relaxed">
          {pricingMethodRule(pricingMethod, companyName)}
        </p>
        <Collapsible open={open} onOpenChange={setOpen} className="mt-1">
          <div className="flex flex-wrap gap-x-4">
            {pdf === null ? (
              <a
                href={PROJECT_TERMS_PAGE_PATH}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleOpened}
                className={LINK_CLASS}
              >
                Read the Project T&Cs
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <TermsPdfLink
                href={pdf.href}
                version={pdf.version}
                surface={pdf.surface}
                mode="new_tab"
                className={LINK_CLASS}
              >
                Agreement dated {formatTermsDate(pdf.version)} (PDF)
              </TermsPdfLink>
            )}
            {config.inShort && (
              <CollapsibleTrigger aria-controls={summaryId} className={LINK_CLASS}>
                {open ? 'Hide summary' : 'In short'}
              </CollapsibleTrigger>
            )}
          </div>
          {config.inShort && (
            <CollapsibleContent id={summaryId}>
              <ul className="text-muted-foreground flex list-disc flex-col gap-1.5 pb-1 pl-5 text-xs leading-relaxed">
                {STANDARD_TERMS.map((term) => (
                  <li key={term}>{term}</li>
                ))}
              </ul>
            </CollapsibleContent>
          )}
        </Collapsible>
      </div>
    </div>
  );
}
