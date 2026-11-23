import { AlertCircle } from 'lucide-react';

/**
 * BAL-555 fix round (pre-PR dedup) — the drill-in's "fetch failed, nothing changed" state is
 * IDENTICAL markup across every fetch-on-select section (`LookupMoneySection`,
 * `LookupTimelineSection`): a labelled/unlabelled container wrapping a plain-words reason and,
 * only for the `unavailable` reason, a Retry button that bumps the caller's own `retryToken`.
 * Hoisted here once both sections had grown the same 15-line block verbatim — extracted rather
 * than left duplicated (SonarCloud's new-code duplication gate) or collapsed into one section
 * (the two still fetch independently and render different content once loaded).
 *
 * BAL-666 — an optional `title` renders an alert icon and a semibold title above the message,
 * for the Follow-ups tab's error state. A caller that passes none is unchanged.
 */
export function LookupSectionRetryNotice({
  containerClassName,
  title,
  message,
  showRetry,
  onRetry,
}: Readonly<{
  containerClassName: string;
  title?: string;
  message: string;
  showRetry: boolean;
  onRetry: () => void;
}>): React.JSX.Element {
  return (
    <div className={containerClassName}>
      {title !== undefined && (
        <div className="mb-1 flex items-center justify-center gap-2">
          <AlertCircle className="text-destructive size-4 shrink-0" aria-hidden="true" />
          <p className="text-foreground text-sm font-semibold">{title}</p>
        </div>
      )}
      <p className="text-muted-foreground text-xs">{message}</p>
      {showRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="text-warning focus-visible:ring-ring mt-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded px-1 text-xs font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          Retry
        </button>
      )}
    </div>
  );
}
