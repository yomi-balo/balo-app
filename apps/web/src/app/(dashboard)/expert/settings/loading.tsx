export default function ExpertSettingsLoading(): React.JSX.Element {
  return (
    <div>
      {/* Tab bar skeleton */}
      <div className="bg-muted mb-7 inline-flex gap-1 rounded-xl p-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-muted-foreground/10 h-9 w-20 animate-pulse rounded-lg" />
        ))}
      </div>
      {/* Content skeleton */}
      <div className="border-border bg-card rounded-xl border p-16 text-center">
        <div className="mx-auto space-y-4">
          <div className="bg-muted mx-auto h-14 w-14 animate-pulse rounded-xl" />
          <div className="bg-muted mx-auto h-5 w-32 animate-pulse rounded" />
          <div className="bg-muted mx-auto h-4 w-64 animate-pulse rounded" />
        </div>
      </div>
    </div>
  );
}
