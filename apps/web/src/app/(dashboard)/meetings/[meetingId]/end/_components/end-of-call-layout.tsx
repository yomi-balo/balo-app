import { Check, CircleDashed, Clock, ShieldCheck } from 'lucide-react';
import { Reveal } from '@/components/balo/engagement/reveal';
import type { EndOfCallRecapState } from '@/lib/meetings/end-of-call-view-types';
import { EndOfCallShell } from './end-of-call-shell';

/**
 * BAL-389 — the SHARED end-of-call shell. One centred card: a mark, a headline, the duration
 * glance, the safe-to-leave reassurance, an optional post-call slot, and the onward CTA.
 *
 * ⚠⚠ THIS MODULE NAMES NOTHING RATING- OR RESOLVE-SHAPED, AND IT MUST NEVER RECEIVE A `lens`
 * PROP. It takes ALREADY-RESOLVED copy from whichever composition rendered it, plus two neutral
 * `ReactNode` slots. A `lens` prop in the shared shell — or a `view.rating` / `view.resolve`
 * read — is exactly the conditional the two-composition structure exists to make impossible,
 * and `expert-end-of-call.test.tsx` scans this file by name to pin that.
 *
 * ⚠⚠ `sessionHeld` IS NOT A LENS, AND IT IS THE ONE CONDITIONAL THIS FILE IS ALLOWED. It is the
 * SAME `meetingAllowsPostCallActions` predicate the loader used to null the two consequential
 * controls, threaded through to the copy — because removing the controls was only half the fix.
 * A member who hand-types this URL for a FUTURE or CANCELLED consultation was still told
 * "Consultation complete" over a success tick and promised a receipt that will never arrive.
 * When it is `false` the card states the truth instead: a NEUTRAL mark, "Nothing to wrap up yet"
 * (supplied by the composition), and no artefact promise of any kind — including the
 * recap-is-being-prepared subcopy, which is the same promise in smaller type. The route STILL
 * RENDERS either way (owner decision): a cosmetic wrong on a throwaway screen beats a dead
 * route, and `notFound()` here would 404 a URL the viewer is legitimately allowed to open.
 * It applies to BOTH lenses; the expert's "notes and payout summary are on the way" is exactly
 * as untrue for a meeting that has not happened.
 *
 * ⚠ DRAFT COPY — pending MJ sign-off. Every string is taken verbatim from
 * `.claude/design-references/end-of-call.jsx`; nothing here is invented.
 *
 * ⚠ NOTHING MONEY-SHAPED. No figure, no currency, no "/min", no credit, no charge, no invoice.
 * The receipt lives on the recap (ADR-1044) and the loader never reads a money row, so this is
 * true by construction rather than by discipline.
 *
 * ⚠ SEMANTIC TOKENS ONLY. The prototype's inline hex palette (`#2563EB`, `#12996B`, …) is
 * PROTOTYPE-ONLY; this renders in `primary` / `success` / `muted-foreground` so it works in dark
 * mode, which the prototype has no concept of.
 *
 * ⚠⚠ THE MOTION IS ONE ORCHESTRATED CASCADE, NOT SCATTERED FLOURISHES. balo-ui puts first paint,
 * meaningful state change and success confirmation at the TOP of the animation budget, and this
 * screen is all three at once — yet it shipped with nothing at all while its sibling recap runs
 * a full staggered reveal. It reuses that same shipped `Reveal` (delays 0.05 → 0.22 there) on a
 * shorter five-rung ladder, so the two meeting surfaces feel like one product. `Reveal` already
 * honours `prefers-reduced-motion` internally — there is no second reduced-motion branch to
 * write here — and the success tick's pop is a `tw-animate-css` utility carrying its own
 * `motion-reduce:animate-none`.
 *
 * ⚠ THE OUTER BOX IS `EndOfCallShell`, SHARED WITH ALL THREE ROUTE-STATE FILES. See its
 * docblock for why the centring, the width and the flat background live in one place.
 */
export function EndOfCallLayout({
  headline,
  counterpartyName,
  durationMinutes,
  reassurance,
  recapState,
  sessionHeld,
  onward,
  postCallActions,
}: Readonly<{
  headline: string;
  counterpartyName: string;
  durationMinutes: number | null;
  reassurance: string;
  recapState: EndOfCallRecapState;
  /**
   * Has this meeting actually reached its start time without being cancelled? `false` switches
   * the card to its neutral variant — see the module docblock. Never a lens, never a role.
   */
  sessionHeld: boolean;
  /** The onward CTA, supplied by the composition so the shell never sees a lens. */
  onward: React.ReactNode;
  /** The client lens's rating + resolve island. `undefined` on the expert lens, and whenever
   *  it would render nothing — handing over a component that returns `null` still leaves a dead
   *  divider and a dead gap on a card this small. */
  postCallActions?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <EndOfCallShell>
      <div className="bg-card border-border w-full rounded-3xl border p-8 text-center shadow-sm">
        <Reveal>
          {sessionHeld ? (
            <span
              aria-hidden="true"
              className="bg-success/10 text-success animate-in fade-in zoom-in-75 mb-4 inline-grid h-14 w-14 place-items-center rounded-full duration-500 motion-reduce:animate-none"
            >
              <Check className="h-6 w-6" strokeWidth={2.5} />
            </span>
          ) : (
            /* ⚠ NEUTRAL, NOT A MUTED SUCCESS TICK. A greyed check still reads "done". */
            <span
              aria-hidden="true"
              className="bg-muted text-muted-foreground mb-4 inline-grid h-14 w-14 place-items-center rounded-full"
            >
              <CircleDashed className="h-6 w-6" strokeWidth={2} />
            </span>
          )}
        </Reveal>

        <Reveal delay={0.05}>
          <h1 className="text-foreground text-xl font-semibold">{headline}</h1>

          {/* ⚠ THE DURATION LINE IS ABSENT, NOT ZEROED, WHENEVER THE STAMPS ARE MISSING (owner
              decision) — no fallback to the scheduled window, no placeholder copy, and never a
              bare "0 min". `>= 1` rather than `!== null` is that rule applied literally: a
              sub-30-second call rounds to 0 and still says nothing. This is 100% of sessions
              today, because BAL-134 owns the stamps and is Backlog. */}
          {durationMinutes !== null && durationMinutes >= 1 && (
            <p className="text-muted-foreground mt-1.5 flex items-center justify-center gap-1.5 text-sm">
              <Clock className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
              {'You spoke for ' + durationMinutes + ' min with ' + counterpartyName}
            </p>
          )}
        </Reveal>

        {/* The one thing that earns its place on a throwaway screen: permission to leave. */}
        <Reveal
          delay={0.1}
          className="border-primary/15 bg-primary/5 dark:bg-primary/10 mt-5 flex w-full items-start gap-2.5 rounded-2xl border px-4 py-3 text-left"
        >
          <ShieldCheck className="text-primary mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
          <p className="text-muted-foreground text-sm leading-relaxed">{reassurance}</p>
        </Reveal>

        {postCallActions !== undefined && (
          <Reveal delay={0.15} className="border-border/60 mt-6 block w-full border-t pt-6">
            {postCallActions}
          </Reveal>
        )}

        <Reveal delay={0.2} className="mt-6 flex w-full flex-col gap-2">
          {onward}
          {sessionHeld && recapState === 'processing' && (
            <p className="text-muted-foreground text-xs">Your recap is being prepared.</p>
          )}
        </Reveal>
      </div>
    </EndOfCallShell>
  );
}
