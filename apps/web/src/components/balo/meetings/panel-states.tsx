'use client';

/**
 * BAL-436 — the side panel's SHARED loading and error surfaces.
 *
 * ⚠ ONE MODULE, TWO SHAPES, USED BY BOTH PANELS. People and Files need byte-identical
 * skeletons and byte-identical error cards; as two copies they would be ~40 duplicated lines
 * and would trip SonarCloud's >3% new-code duplication gate.
 *
 * ⚠⚠ **NO `aria-busy` ANYWHERE.** It SUPPRESSES the announcements this surface's live regions
 * exist to make, and `meeting-call-no-lens-gate.test.ts` fails the build over it. A skeleton
 * is `aria-hidden` decoration; the STATE is carried by the error card's text when there is
 * one, and by the list itself when there is not.
 *
 * ⚠ THE EMPTY STATE IS NOT HERE, DELIBERATELY. An empty section is an INVITATION TO ACT and
 * its copy is specific to what the person could do next — so each panel writes its own,
 * rather than sharing a generic "nothing here" that would be absence-framed by construction.
 */

/** Three placeholder rows. ⚠ Decoration: hidden from assistive tech entirely. */
export function PanelSkeletonRows(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 p-2" data-testid="panel-skeleton" aria-hidden="true">
      {/* ⚠ FIXED LITERAL KEYS, never an array index (SonarCloud S6479). */}
      {['a', 'b', 'c'].map((key) => (
        <div key={key} className="flex items-center gap-3">
          <span className="bg-muted h-[34px] w-[34px] shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="bg-muted h-3 w-2/5 animate-pulse rounded motion-reduce:animate-none" />
            <span className="bg-muted h-2.5 w-3/5 animate-pulse rounded motion-reduce:animate-none" />
          </span>
        </div>
      ))}
    </div>
  );
}

export interface PanelErrorCardProps {
  readonly title: string;
  /**
   * ⚠ THE BODY MUST SAY WHAT STILL WORKS. A failed roster read does not break the call and
   * does not remove the footer's controls; saying so is the difference between an error the
   * person can move past and one that reads like the call is broken.
   */
  readonly body: string;
  readonly onRetry: () => void;
}

export function PanelErrorCard({
  title,
  body,
  onRetry,
}: Readonly<PanelErrorCardProps>): React.JSX.Element {
  return (
    <div
      className="border-border bg-muted/30 m-2 flex flex-col gap-2 rounded-xl border p-3"
      data-testid="panel-error"
    >
      <p className="text-foreground text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-xs leading-relaxed">{body}</p>
      <button
        type="button"
        onClick={onRetry}
        className="border-border text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center justify-center self-start rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        Try again
      </button>
    </div>
  );
}
