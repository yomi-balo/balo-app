export default function ApplicationReviewLoading(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[780px] space-y-9 py-8 pb-20">
      {/* Page header skeleton */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="bg-muted h-10 w-10 animate-pulse rounded-[11px]" />
          <div className="bg-muted h-7 w-48 animate-pulse rounded" />
        </div>
        <div className="bg-muted ml-[52px] h-4 w-80 animate-pulse rounded" />
      </div>

      {/* Status banner skeleton */}
      <div className="bg-muted h-20 w-full animate-pulse rounded-[14px]" />

      {/* Section skeletons */}
      {['section-1', 'section-2', 'section-3', 'section-4'].map((id) => (
        <div key={id} className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="bg-muted h-[26px] w-[26px] animate-pulse rounded-[7px]" />
            <div className="bg-muted h-3 w-32 animate-pulse rounded" />
          </div>
          <div className="bg-muted h-28 w-full animate-pulse rounded-[14px]" />
        </div>
      ))}
    </div>
  );
}
