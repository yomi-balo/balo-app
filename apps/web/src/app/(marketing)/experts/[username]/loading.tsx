/**
 * Route-level loading UI for `/experts/[username]`, shown during the RSC profile
 * fetch. Mirrors the real layout: a dark `.expert-hero` shell, a sticky-nav bar
 * shell, then the two-column body with skeleton section cards + booking card.
 * No spinners.
 */
export default function ExpertProfileLoading(): React.JSX.Element {
  return (
    <div className="bg-background min-h-screen">
      {/* Hero shell */}
      <div className="expert-hero relative overflow-hidden pb-16 md:pb-22">
        <div className="relative mx-auto max-w-[1120px] px-5 md:px-8">
          <div className="flex items-center justify-between py-5">
            <div className="h-9 w-36 animate-pulse rounded-[9px] bg-white/10" />
            <div className="flex gap-2">
              <div className="h-9 w-9 animate-pulse rounded-[9px] bg-white/10" />
              <div className="h-9 w-9 animate-pulse rounded-[9px] bg-white/10" />
            </div>
          </div>
          <div className="flex flex-col gap-6 pt-4 md:flex-row md:gap-10 md:pt-6">
            <div className="aspect-[7/8] w-[150px] shrink-0 animate-pulse rounded-[22px] bg-white/10 md:w-[250px]" />
            <div className="flex min-w-0 flex-1 flex-col justify-between gap-6">
              <div>
                <div className="h-9 w-64 max-w-full animate-pulse rounded bg-white/10" />
                <div className="mt-3 h-4 w-80 max-w-full animate-pulse rounded bg-white/10" />
                <div className="mt-4 h-3.5 w-56 max-w-full animate-pulse rounded bg-white/10" />
              </div>
              <div className="h-20 w-full animate-pulse rounded-2xl bg-white/5" />
            </div>
          </div>
        </div>
      </div>

      {/* Sticky-nav shell */}
      <div className="border-border/60 bg-background/85 border-b">
        <div className="mx-auto flex max-w-[1120px] gap-6 px-5 py-3.5 md:px-8">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="bg-muted h-5 w-16 animate-pulse rounded" />
          ))}
        </div>
      </div>

      {/* Two-column body shell */}
      <div className="mx-auto max-w-[1120px] px-5 pb-12 md:px-8 md:pb-16">
        <div className="flex flex-col gap-4 pt-5 md:grid md:grid-cols-[minmax(0,1fr)_360px] md:items-start md:gap-7 md:pt-7">
          <div className="flex flex-col gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="border-border bg-card rounded-xl border p-7">
                <div className="bg-muted h-3 w-24 animate-pulse rounded" />
                <div className="bg-muted mt-4 h-4 w-full animate-pulse rounded" />
                <div className="bg-muted mt-2 h-4 w-5/6 animate-pulse rounded" />
                <div className="bg-muted mt-2 h-4 w-2/3 animate-pulse rounded" />
              </div>
            ))}
          </div>
          <div className="border-border bg-card rounded-xl border p-6">
            <div className="bg-muted h-8 w-32 animate-pulse rounded" />
            <div className="bg-muted mt-5 h-12 w-full animate-pulse rounded-[11px]" />
            <div className="bg-muted mt-4 h-16 w-full animate-pulse rounded-[11px]" />
          </div>
        </div>
      </div>
    </div>
  );
}
