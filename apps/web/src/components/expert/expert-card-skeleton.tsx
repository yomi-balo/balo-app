import { Card } from '@/components/ui/card';

export function ExpertCardSkeleton(): React.JSX.Element {
  return (
    <Card
      className="gap-0 overflow-hidden rounded-xl border py-0 shadow-sm"
      role="status"
      aria-label="Loading expert card"
    >
      {/* Photo hero placeholder */}
      <div className="bg-muted aspect-[3/2] animate-pulse" />

      {/* Bio placeholder */}
      <div className="space-y-2 px-4 pt-3 pb-2">
        <div className="bg-muted h-3 w-full animate-pulse rounded" />
        <div className="bg-muted h-3 w-4/5 animate-pulse rounded" />
        <div className="bg-muted h-3 w-3/5 animate-pulse rounded" />
      </div>

      {/* Stats strip placeholder */}
      <div className="flex items-center gap-3 px-4 py-2">
        <div className="bg-muted h-3 w-12 animate-pulse rounded" />
        <div className="bg-muted h-3 w-16 animate-pulse rounded" />
        <div className="bg-muted h-3 w-14 animate-pulse rounded" />
      </div>

      {/* Expertise pills placeholder */}
      <div className="flex gap-2 px-4 py-2">
        <div className="bg-muted h-6 w-24 animate-pulse rounded-full" />
        <div className="bg-muted h-6 w-20 animate-pulse rounded-full" />
        <div className="bg-muted h-6 w-28 animate-pulse rounded-full" />
      </div>

      {/* CTA row placeholder */}
      <div className="border-border flex items-center justify-between border-t px-4 py-3">
        <div className="bg-muted h-5 w-20 animate-pulse rounded" />
        <div className="bg-muted h-9 w-32 animate-pulse rounded-lg" />
      </div>
    </Card>
  );
}
