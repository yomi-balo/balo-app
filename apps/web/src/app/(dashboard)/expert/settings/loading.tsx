export default function ExpertSettingsLoading(): React.JSX.Element {
  return (
    <div>
      {/* Main tab bar skeleton (pill style — 4 tabs) */}
      <div className="bg-muted mb-7 inline-flex gap-1 rounded-xl p-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-muted-foreground/10 h-9 w-24 animate-pulse rounded-lg" />
        ))}
      </div>
      {/* Sub tab bar skeleton (underline style — 4 tabs) */}
      <div className="border-border mb-7 flex gap-0 border-b">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-4 py-2.5">
            <div className="bg-muted-foreground/10 h-5 w-24 animate-pulse rounded" />
          </div>
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
