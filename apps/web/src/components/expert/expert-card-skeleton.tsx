import { Card } from '@/components/ui/card';

interface ExpertCardSkeletonProps {
  variant?: 'grid' | 'list';
}

function GridSkeleton(): React.JSX.Element {
  return (
    <Card
      className="gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm"
      role="status"
      aria-label="Loading expert card"
    >
      {/* Photo box */}
      <div className="bg-muted aspect-[5/4] w-full animate-pulse" />

      {/* Name + rate strip */}
      <div className="flex items-start justify-between px-4 pt-3.5 pb-1">
        <div className="space-y-1.5">
          <div className="bg-muted h-4 w-32 animate-pulse rounded" />
          <div className="bg-muted h-3 w-24 animate-pulse rounded" />
        </div>
        <div className="space-y-1.5 text-right">
          <div className="bg-muted h-5 w-16 animate-pulse rounded" />
          <div className="bg-muted h-2.5 w-12 animate-pulse rounded" />
        </div>
      </div>

      {/* Stats strip — 3 columns */}
      <div className="border-border/50 mx-4 my-2.5 border-y py-3">
        <div className="grid grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <div className="bg-muted h-4 w-4 animate-pulse rounded" />
              <div className="bg-muted h-2.5 w-12 animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>

      {/* Title */}
      <div className="space-y-1.5 px-4 pt-1 pb-2">
        <div className="bg-muted h-4 w-full animate-pulse rounded" />
        <div className="bg-muted h-3 w-3/5 animate-pulse rounded" />
      </div>

      {/* Bio — 4 lines */}
      <div className="space-y-1.5 px-4 pb-3">
        {['w-full', 'w-5/6', 'w-full-2', 'w-2/3'].map((w) => (
          <div
            key={w}
            className={`bg-muted h-3 ${w === 'w-full-2' ? 'w-full' : w} animate-pulse rounded`}
          />
        ))}
      </div>

      {/* Pills */}
      <div className="flex flex-wrap gap-2 px-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-muted h-7 w-24 animate-pulse rounded-full" />
        ))}
      </div>

      {/* CTA row */}
      <div className="mx-4 mt-3.5 mb-4 flex gap-2">
        <div className="bg-muted h-11 flex-1 animate-pulse rounded-lg" />
        <div className="bg-muted h-11 flex-1 animate-pulse rounded-lg" />
      </div>
    </Card>
  );
}

function ListSkeleton(): React.JSX.Element {
  return (
    <Card
      className="flex gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm"
      role="status"
      aria-label="Loading expert card"
    >
      {/* Photo panel */}
      <div className="bg-muted w-60 shrink-0 animate-pulse self-stretch" />

      {/* Content */}
      <div className="flex-1 space-y-3 p-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <div className="bg-muted h-5 w-40 animate-pulse rounded" />
            <div className="bg-muted h-3 w-2/3 animate-pulse rounded" />
          </div>
          <div className="bg-muted h-5 w-20 animate-pulse rounded" />
        </div>
        <div className="bg-muted h-4 w-1/2 animate-pulse rounded" />
        <div className="space-y-1.5">
          <div className="bg-muted h-3 w-full animate-pulse rounded" />
          <div className="bg-muted h-3 w-4/5 animate-pulse rounded" />
        </div>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-muted h-7 w-24 animate-pulse rounded-full" />
          ))}
        </div>
        <div className="flex gap-2.5">
          <div className="bg-muted h-11 w-[200px] animate-pulse rounded-lg" />
          <div className="bg-muted h-11 w-[200px] animate-pulse rounded-lg" />
        </div>
      </div>
    </Card>
  );
}

export function ExpertCardSkeleton({
  variant = 'grid',
}: Readonly<ExpertCardSkeletonProps>): React.JSX.Element {
  return variant === 'list' ? <ListSkeleton /> : <GridSkeleton />;
}
