import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { HelpGuideSummary } from '@/lib/help/types';

interface GuideRowsProps {
  items: readonly HelpGuideSummary[];
  hrefFor: (slug: string) => string;
}

/** A divided list of guide links: title, one-line summary and a chevron. */
export function GuideRows({ items, hrefFor }: Readonly<GuideRowsProps>): React.JSX.Element {
  return (
    <ul className="border-line-soft m-0 list-none border-t p-0">
      {items.map((item) => (
        <li key={item.slug} className="border-line-soft border-b">
          <Link
            href={hrefFor(item.slug)}
            className="group hover:bg-mist focus-visible:ring-ring flex min-h-11 items-center gap-4 rounded-md px-2 py-3.5 transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none"
          >
            <span className="block min-w-0 flex-1">
              <span className="text-foreground group-hover:text-primary block text-base leading-snug font-semibold transition-colors motion-reduce:transition-none">
                {item.title}
              </span>
              <span className="text-muted-foreground mt-0.5 block text-sm leading-normal">
                {item.summary}
              </span>
            </span>
            <ChevronRight
              aria-hidden="true"
              className="text-muted-foreground size-[18px] shrink-0 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}
