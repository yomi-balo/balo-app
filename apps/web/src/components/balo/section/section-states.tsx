import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Info, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Shared presentational primitives for section-shaped surfaces: the section shell, a compact
 * section HEAD, and the three non-loaded async states (skeleton / empty invitation /
 * error+retry). Semantic tokens + dark mode throughout; no client interactivity of their own
 * (the retry callback is owned by the caller — a route `error.tsx` reset or a tab's
 * `router.refresh`).
 *
 * ⚠ MOVED HERE FROM `components/balo/domain-join/` BY BAL-388 — MOVED, NOT COPIED. These were
 * never domain-join-specific; they are the app's section vocabulary, and the recap page is the
 * second consumer family. Re-spelling four components into a second file is exactly the shape
 * SonarCloud's >3% new-code duplication gate exists to catch, so the module moved and its six
 * importers were re-pointed. The colocated `section-states.test.tsx` moved with it, so coverage
 * follows the moved lines.
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

interface SectionHeadProps {
  icon: LucideIcon;
  title: string;
  /** Right-aligned muted meta ("AI-generated", "2/3 done", a file count). */
  meta?: string;
}

/**
 * A compact section head — a 15px muted icon + `text-sm font-semibold` title, with optional
 * right-aligned muted meta. This is the header a card uses INSIDE its own container, unlike
 * {@link SectionCard}, which brings its own shell.
 *
 * ⚠ BUILT HERE, NOT COPIED FROM THE PROTOTYPE. `.claude/design-references/case-surface.jsx`
 * draws this shape with inline hex and no tokens; this is the tokenised, dark-mode-safe
 * version, and it lives beside the other section primitives so a third consumer reuses it
 * rather than re-spelling it.
 */
export function SectionHead({
  icon: Icon,
  title,
  meta,
}: Readonly<SectionHeadProps>): React.JSX.Element {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3">
      <div className="flex items-center gap-2">
        <Icon size={15} className="text-muted-foreground" aria-hidden="true" />
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
      </div>
      {meta && <span className="text-muted-foreground text-xs">{meta}</span>}
    </div>
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

/**
 * The default reassurance line under a section error. Named, so the `body` override below is
 * visibly a REPLACEMENT of a real default rather than an empty string.
 */
const DEFAULT_SECTION_ERROR_BODY = 'This is usually temporary. Your settings are safe.';

interface SectionErrorProps {
  /** Completes "We couldn't load {label}". */
  label: string;
  onRetry: () => void;
  /**
   * Reassurance line. Defaults to the settings-shaped copy the domain-join surfaces ship
   * with; the recap overrides it, because nothing on a recap is "your settings". Additive —
   * every existing call site keeps the original string with no change.
   */
  body?: string;
}

/** Error state with a retry affordance. `label` completes "We couldn't load {label}". */
export function SectionError({
  label,
  onRetry,
  body = DEFAULT_SECTION_ERROR_BODY,
}: Readonly<SectionErrorProps>): React.JSX.Element {
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
        {body}
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
