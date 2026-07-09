import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Info, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Shared presentational primitives for the domain-join admin surfaces (BAL-347):
 * the section shell + the three non-loaded async states (skeleton / empty invitation
 * / error+retry). Semantic tokens + dark mode throughout; no client interactivity of
 * their own (the retry callback is owned by the caller — a route `error.tsx` reset or
 * the agency tab's `router.refresh`).
 */

interface SectionCardProps {
  title: string;
  description?: string;
  headerRight?: ReactNode;
  children: ReactNode;
}

/** A full-width settings section card with a title/description header. */
export function SectionCard({
  title,
  description,
  headerRight,
  children,
}: Readonly<SectionCardProps>): React.JSX.Element {
  return (
    <section className="bg-card border-border rounded-2xl border p-6 shadow-sm sm:p-7">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-foreground text-base font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{description}</p>
          )}
        </div>
        {headerRight}
      </header>
      {children}
    </section>
  );
}

/** A pulse skeleton of `rows` list rows for the loading state. */
export function SectionSkeleton({ rows = 3 }: Readonly<{ rows?: number }>): React.JSX.Element {
  const keys = Array.from({ length: rows }, (_, i) => `skeleton-${i}`);
  return (
    <output aria-label="Loading" className="flex flex-col gap-1">
      {keys.map((key) => (
        <div key={key} className="flex items-center gap-3 py-3">
          <div className="bg-muted h-9 w-9 flex-none animate-pulse rounded-lg" />
          <div className="flex-1 space-y-2">
            <div className="bg-muted h-3 w-2/5 animate-pulse rounded" />
            <div className="bg-muted/60 h-2.5 w-3/5 animate-pulse rounded" />
          </div>
          <div className="bg-muted h-6 w-16 flex-none animate-pulse rounded-full" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </output>
  );
}

interface SectionEmptyProps {
  icon: LucideIcon;
  title: string;
  body: string;
  children?: ReactNode;
}

/** Empty state framed as an invitation (icon + title + body + optional action). */
export function SectionEmpty({
  icon: Icon,
  title,
  body,
  children,
}: Readonly<SectionEmptyProps>): React.JSX.Element {
  return (
    <div className="px-4 pt-6 pb-2 text-center">
      <span
        aria-hidden="true"
        className="bg-primary/10 text-primary mb-3.5 inline-grid h-13 w-13 place-items-center rounded-xl"
      >
        <Icon className="h-6 w-6" />
      </span>
      <h3 className="text-foreground text-[15px] font-semibold">{title}</h3>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-sm leading-relaxed">
        {body}
      </p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** Error state with a retry affordance. `label` completes "We couldn't load {label}". */
export function SectionError({
  label,
  onRetry,
}: Readonly<{ label: string; onRetry: () => void }>): React.JSX.Element {
  return (
    <div role="alert" className="px-4 pt-6 pb-2 text-center">
      <span
        aria-hidden="true"
        className="bg-destructive/10 text-destructive mb-3.5 inline-grid h-13 w-13 place-items-center rounded-xl"
      >
        <AlertTriangle className="h-6 w-6" />
      </span>
      <h3 className="text-foreground text-[15px] font-semibold">{`We couldn't load ${label}`}</h3>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-sm leading-relaxed">
        This is usually temporary. Your settings are safe.
      </p>
      <div className="mt-4 flex justify-center">
        <Button type="button" variant="outline" onClick={onRetry} className="gap-2">
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Try again
        </Button>
      </div>
    </div>
  );
}

/** A calm info callout — used to make an intentional absence explicit (agency note)
 * or to tie the join-request queue to the current join mode. */
export function InfoNote({
  icon: Icon = Info,
  children,
}: Readonly<{ icon?: LucideIcon; children: ReactNode }>): React.JSX.Element {
  return (
    <div className="bg-primary/5 border-border flex items-start gap-2.5 rounded-xl border px-3.5 py-3">
      <Icon className="text-primary mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
      <p className="text-foreground text-[13px] leading-relaxed">{children}</p>
    </div>
  );
}
