import { EndOfCallShell } from './_components/end-of-call-shell';

/**
 * BAL-389 — the end-of-call screen's route-level LOADING state.
 *
 * ⚠ IT MIRRORS **THIS** SCREEN, NOT THE RECAP. The recap's skeleton is a three-column
 * header-plus-rail; this screen is ONE centred card. Reusing the recap's would re-flow the whole
 * viewport the moment the data lands, which is the exact thing a loading file exists to prevent.
 *
 * ⚠ `<output>`, NOT `role="status"` (SonarCloud S6819), with an accessible label.
 *
 * ⚠⚠ THE CENTRING, THE WIDTH AND THE BACKGROUND COME FROM `EndOfCallShell`, NOT FROM A COPY OF
 * ITS CLASSES. They used to be restated here and in `EndOfCallLayout`, which is how the loaded
 * card and the skeleton drift out of alignment and re-flow the viewport at the exact moment the
 * data lands — the one thing a loading file exists to prevent.
 *
 * ⚠ `motion-reduce:animate-none` ON EVERY PULSING SPAN. A skeleton is the longest-running
 * animation on the route, and `prefers-reduced-motion` is set by people for whom a looping pulse
 * is not a stylistic preference. The layout is unchanged either way — the bars just hold still.
 */
export default function EndOfCallLoading(): React.JSX.Element {
  return (
    <EndOfCallShell>
      <output
        aria-label="Loading"
        className="bg-card border-border block w-full rounded-3xl border p-8 text-center"
      >
        <span className="bg-muted mx-auto mb-4 block h-14 w-14 animate-pulse rounded-full motion-reduce:animate-none" />
        <span className="bg-muted mx-auto mb-2.5 block h-5 w-48 animate-pulse rounded motion-reduce:animate-none" />
        <span className="bg-muted/60 mx-auto mb-5 block h-3 w-56 animate-pulse rounded motion-reduce:animate-none" />
        <span className="bg-muted/40 mb-6 block h-16 w-full animate-pulse rounded-2xl motion-reduce:animate-none" />
        {/* ⚠ Keys come from a FIXED literal array — never an array index (SonarCloud S6479). */}
        {LINE_KEYS.map((key) => (
          <span
            key={key}
            className="bg-muted/60 mx-auto mb-2.5 block h-3 w-2/3 animate-pulse rounded motion-reduce:animate-none"
          />
        ))}
        <span className="bg-muted mt-6 block h-12 w-full animate-pulse rounded-xl motion-reduce:animate-none" />
        <span className="sr-only">Loading…</span>
      </output>
    </EndOfCallShell>
  );
}

const LINE_KEYS = ['a', 'b'] as const;
