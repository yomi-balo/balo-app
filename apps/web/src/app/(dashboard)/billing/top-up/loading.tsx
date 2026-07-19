/**
 * BAL-377 top-up loading state — the prototype's dark-hero shimmer skeleton (never a bare
 * spinner). The hero stays deliberately dark in both themes; the body shows three content
 * shimmer bars.
 */
export default function TopUpLoading() {
  return (
    <div className="flex min-h-[80vh] items-start justify-center px-4 py-10">
      <div className="border-border bg-card w-full max-w-[540px] overflow-hidden rounded-2xl border shadow-sm">
        <div className="space-y-4 bg-gradient-to-br from-[#0F1729] to-[#1E293B] px-7 pt-6 pb-8">
          <div className="h-3 w-28 animate-pulse rounded bg-white/10" />
          <div className="h-11 w-56 animate-pulse rounded bg-white/10" />
          <div className="h-3.5 w-36 animate-pulse rounded bg-white/10" />
        </div>
        <div className="space-y-4 p-6">
          <div className="bg-muted h-14 w-full animate-pulse rounded-lg" />
          <div className="bg-muted h-28 w-full animate-pulse rounded-lg" />
          <div className="bg-muted h-12 w-full animate-pulse rounded-lg" />
        </div>
      </div>
    </div>
  );
}
