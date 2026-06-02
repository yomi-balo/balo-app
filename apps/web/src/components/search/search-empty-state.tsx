import Link from 'next/link';
import { CalendarClock, SearchX } from 'lucide-react';
import { ZeroResultsTracker } from './zero-results-tracker';

interface SearchEmptyStateProps {
  /** `true` → matched experts exist but none are currently bookable (gate on). */
  wasAvailabilityGated: boolean;
  /** Serialised filters for the analytics event. */
  filters: Record<string, unknown>;
}

interface EmptyCopy {
  Icon: typeof SearchX;
  title: string;
  description: string;
}

const GATED_COPY: EmptyCopy = {
  Icon: CalendarClock,
  title: 'No experts available in that window',
  description:
    'We found experts who match your filters, but none have open availability right now. Try widening the timeframe or clearing it to see everyone who matches.',
};

const NOT_FOUND_COPY: EmptyCopy = {
  Icon: SearchX,
  title: 'No experts match those filters',
  description:
    'Nobody matches every filter you selected. Try removing a filter or broadening your search to see more experts.',
};

/**
 * Server-rendered zero-results UI with two copy variants gated by
 * `wasAvailabilityGated`. The clear-all CTA is a plain `<Link href="/experts">`.
 * Analytics fire from the embedded client `ZeroResultsTracker`.
 */
export function SearchEmptyState({
  wasAvailabilityGated,
  filters,
}: Readonly<SearchEmptyStateProps>): React.JSX.Element {
  const { Icon, title, description } = wasAvailabilityGated ? GATED_COPY : NOT_FOUND_COPY;

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <ZeroResultsTracker filters={filters} wasAvailabilityGated={wasAvailabilityGated} />
      <div className="bg-muted mb-4 rounded-xl p-4">
        <Icon className="text-muted-foreground h-8 w-8" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">{title}</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">{description}</p>
      <Link
        href="/experts"
        className="border-border text-foreground hover:bg-muted focus-visible:ring-ring mt-4 inline-flex h-10 items-center justify-center rounded-lg border px-5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        Clear all filters
      </Link>
    </div>
  );
}
