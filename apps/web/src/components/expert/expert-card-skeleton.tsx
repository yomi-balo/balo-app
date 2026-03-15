import { Card } from '@/components/ui/card';

export function ExpertCardSkeleton(): React.JSX.Element {
  return (
    <Card
      className="gap-0 overflow-hidden rounded-xl border py-0 shadow-sm"
      role="status"
      aria-label="Loading expert card"
    >
      {/* Dark header with centered avatar */}
      <div className="flex flex-col items-center bg-gradient-to-br from-[#0F1729] to-[#1E293B] px-4 pt-4 pb-5 dark:from-[#0a0f1a] dark:to-[#151d2e]">
        {/* Avatar circle */}
        <div className="mt-4 h-[94px] w-[94px] animate-pulse rounded-full bg-white/10" />
        {/* Name + rate row */}
        <div className="mt-3 flex w-full items-start justify-between">
          <div className="space-y-1.5">
            <div className="h-4 w-28 animate-pulse rounded bg-white/10" />
            <div className="h-3 w-20 animate-pulse rounded bg-white/10" />
          </div>
          <div className="space-y-1.5 text-right">
            <div className="h-5 w-16 animate-pulse rounded bg-white/10" />
            <div className="h-2.5 w-12 animate-pulse rounded bg-white/10" />
          </div>
        </div>
      </div>

      {/* Title placeholder */}
      <div className="px-4 pt-3 pb-2">
        <div className="bg-muted h-4 w-full animate-pulse rounded" />
        <div className="bg-muted mt-1 h-3 w-3/5 animate-pulse rounded" />
      </div>

      {/* Bio placeholder */}
      <div className="px-4 pb-3">
        <div className="border-muted bg-muted/30 animate-pulse rounded-r-lg border-l-2 py-2 pr-3 pl-3">
          <div className="space-y-1.5">
            <div className="bg-muted h-3 w-full rounded" />
            <div className="bg-muted h-3 w-4/5 rounded" />
            <div className="bg-muted h-3 w-3/5 rounded" />
          </div>
        </div>
      </div>

      {/* Stats strip placeholder */}
      <div className="border-border/50 flex items-center justify-evenly border-y px-4 py-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex flex-col items-center gap-1">
            <div className="bg-muted h-4 w-4 animate-pulse rounded" />
            <div className="bg-muted h-2.5 w-12 animate-pulse rounded" />
          </div>
        ))}
      </div>

      {/* Expertise pills placeholder */}
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="bg-muted h-7 w-32 animate-pulse rounded-full" />
        <div className="bg-muted h-7 w-28 animate-pulse rounded-full" />
        <div className="bg-muted h-7 w-24 animate-pulse rounded-full" />
      </div>

      {/* CTA row placeholder */}
      <div className="border-border flex items-center gap-2 border-t px-4 py-3">
        <div className="bg-muted h-11 flex-1 animate-pulse rounded-lg" />
        <div className="bg-muted h-11 flex-1 animate-pulse rounded-lg" />
      </div>
    </Card>
  );
}
