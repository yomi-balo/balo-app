import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { HelpAudience } from '@/lib/analytics';
import { helpIndexHref } from '@/lib/help/audience';
import type { HelpCategory, HelpGuide } from '@/lib/help/types';
import { cn } from '@/lib/utils';
import { formatHelpDate } from './format-help-date';

interface GuideHeaderProps {
  guide: Pick<HelpGuide, 'title' | 'summary' | 'updated'>;
  side: HelpAudience;
  category: HelpCategory | undefined;
}

const SIDE_LABEL: Readonly<Record<HelpAudience, string>> = {
  client: 'For clients',
  expert: 'For experts',
};

interface Crumb {
  label: string;
  href: string;
}

/** Breadcrumb, title, summary, audience chip and last-updated date of a guide. */
export function GuideHeader({
  guide,
  side,
  category,
}: Readonly<GuideHeaderProps>): React.JSX.Element {
  const crumbs: Crumb[] = [
    { label: 'Help', href: helpIndexHref() },
    { label: SIDE_LABEL[side], href: helpIndexHref(side) },
    ...(category === undefined
      ? []
      : [{ label: category.title, href: helpIndexHref(side, category.id) }]),
  ];

  return (
    <header>
      <nav aria-label="Breadcrumb">
        <ol className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-[13.5px]">
          {crumbs.map((crumb, index) => (
            <li key={crumb.label} className="flex items-center gap-1.5">
              {index > 0 ? (
                <ChevronRight aria-hidden="true" className="text-muted-foreground size-3.5" />
              ) : null}
              <Link
                href={crumb.href}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 md:min-h-0"
              >
                {crumb.label}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      <h1 className="text-foreground mt-[18px] mb-0 text-[30px] leading-[1.12] font-bold tracking-tight md:text-[38px]">
        {guide.title}
      </h1>
      <p className="text-muted-foreground mt-3 max-w-[60ch] text-lg leading-relaxed">
        {guide.summary}
      </p>
      <div className="mt-[18px] flex flex-wrap items-center gap-3">
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2.5 py-1 text-[12.5px] font-semibold',
            side === 'expert'
              ? 'bg-night border-night text-night-foreground'
              : 'bg-mist border-line text-foreground'
          )}
        >
          {SIDE_LABEL[side]}
        </span>
        <span className="text-muted-foreground text-[13.5px]">
          Updated <time dateTime={guide.updated}>{formatHelpDate(guide.updated)}</time>
        </span>
      </div>
    </header>
  );
}
