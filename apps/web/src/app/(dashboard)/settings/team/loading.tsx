import { SectionCard, SectionSkeleton } from '@/components/balo/domain-join/section-states';

/**
 * Three block skeletons that match the loaded join-mode shape (three radio-cards),
 * rather than the list-row `SectionSkeleton` (avatar + two lines + pill) used by the
 * Domains + queue sections.
 */
function JoinModeSkeleton(): React.JSX.Element {
  const keys = ['auto', 'request', 'off'];
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-2.5">
      {keys.map((key) => (
        <div key={key} className="bg-muted h-16 w-full animate-pulse rounded-xl" />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Route-level loading skeleton for the company Members & access surface (BAL-347). */
export default function Loading(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="bg-muted mb-6 h-9 w-56 animate-pulse rounded-lg" />
      <div className="flex flex-col gap-4">
        <SectionCard title="Domains">
          <SectionSkeleton rows={3} />
        </SectionCard>
        <SectionCard title="Join mode">
          <JoinModeSkeleton />
        </SectionCard>
        <SectionCard title="Join requests">
          <SectionSkeleton rows={2} />
        </SectionCard>
      </div>
    </div>
  );
}
