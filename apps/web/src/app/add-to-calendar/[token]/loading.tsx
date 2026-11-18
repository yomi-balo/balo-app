import { BaloCard } from '@/components/balo/card/balo-card';

export default function AddToCalendarLoading(): React.JSX.Element {
  return (
    <output className="mx-auto block w-full max-w-md">
      <span className="sr-only">Loading your calendar options…</span>
      <BaloCard aria-busy="true" className="w-full p-6 sm:p-8">
        <div className="bg-muted h-12 w-12 animate-pulse rounded-2xl" />
        <div className="bg-muted mt-4 h-6 w-2/3 animate-pulse rounded" />
        <div className="bg-muted mt-2 h-4 w-1/2 animate-pulse rounded" />
        <div className="border-border mt-6 space-y-2 border-t pt-5">
          {['google', 'outlook', 'work', 'ics'].map((row) => (
            <div key={row} className="bg-muted h-9 w-full animate-pulse rounded-md" />
          ))}
        </div>
      </BaloCard>
    </output>
  );
}
