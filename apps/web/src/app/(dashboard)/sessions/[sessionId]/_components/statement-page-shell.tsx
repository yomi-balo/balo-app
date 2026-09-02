/**
 * BAL-441 — the ONE outer wrapper every route state (loaded, loading, error, not-found) renders
 * into, so the container width and padding stay IDENTICAL across all four and the route never
 * visibly jumps between them (only vertical padding may differ — matches
 * `cases/[engagementId]/loading.tsx`'s stated discipline).
 *
 * Single column, narrower than the app's usual `max-w-7xl` dashboard grid — this is a document,
 * not a workspace (design principle "One document, not a dashboard").
 */
export function StatementPageShell({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="from-background to-muted/30 min-h-[70vh] bg-gradient-to-b py-12 lg:py-16">
      <div className="mx-auto max-w-2xl px-4 sm:px-6">{children}</div>
    </div>
  );
}

/** The one statement `Card` surface. Spacious density floor at the smallest breakpoint. */
export function StatementCard({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-xl border p-5 shadow-sm sm:p-8 lg:p-10">
      {children}
    </div>
  );
}
