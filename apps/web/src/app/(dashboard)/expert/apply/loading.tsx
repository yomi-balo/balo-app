import { Card } from '@/components/ui/card';

export default function ExpertApplyLoading(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      {/* Progress bar skeleton */}
      <div className="hidden items-center justify-between md:flex">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <div className="bg-muted h-8 w-8 animate-pulse rounded-full" />
            <div className="bg-muted h-3 w-12 animate-pulse rounded" />
          </div>
        ))}
      </div>

      {/* Mobile progress skeleton */}
      <div className="space-y-2 md:hidden">
        <div className="bg-muted h-1.5 w-full animate-pulse rounded-full" />
        <div className="bg-muted mx-auto h-3 w-24 animate-pulse rounded" />
      </div>

      {/* Form card skeleton */}
      <Card className="p-8">
        <div className="space-y-6">
          <div className="bg-muted h-7 w-48 animate-pulse rounded" />
          <div className="bg-muted h-4 w-80 animate-pulse rounded" />
          <div className="space-y-4 pt-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-muted h-12 w-full animate-pulse rounded-lg" />
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
