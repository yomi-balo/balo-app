/**
 * BAL-132 — the lobby segment's loading state.
 *
 * ⚠ `<output>`, NOT `role="status"` — SonarCloud S6819 flags the ARIA role where a native
 * element exists, and it escapes local lint (memory
 * `reference_sonarcloud_void_and_output_rules_missed_locally`). The `sr-only` line is what a
 * screen reader announces; the skeleton is decorative.
 *
 * ⚠⚠ `aria-busy` SITS ON THE **DECORATIVE WRAPPER**, NEVER ON THE ELEMENT CARRYING THE
 * `sr-only` TEXT. `aria-busy` tells assistive tech to SUPPRESS a live region's announcements —
 * so putting it on the `<output>` silenced the very "Loading…" line the `<output>` exists to
 * announce. On the skeleton `<div>` it means what it should: this subtree is being built.
 *
 * ⚠ THE SKELETON DELIBERATELY MIRRORS THE **FORM**, not a meeting summary. This route never
 * knows anything about the meeting (the page performs zero database reads), so a skeleton
 * shaped like a title and a date would promise content that is never coming.
 */
export default function LobbyLoading(): React.JSX.Element {
  return (
    <output className="mx-auto block w-full max-w-md">
      <span className="sr-only">Loading…</span>
      <div
        aria-busy="true"
        className="border-border bg-card w-full rounded-2xl border p-8 shadow-sm"
      >
        <div className="bg-muted mx-auto h-12 w-12 animate-pulse rounded-2xl" />
        <div className="bg-muted mx-auto mt-4 h-6 w-2/3 animate-pulse rounded" />
        <div className="bg-muted mx-auto mt-2 h-4 w-1/2 animate-pulse rounded" />

        <div className="mt-6 space-y-4">
          {/* ⚠ STABLE LITERAL KEYS, never an array index (S6479). */}
          {['name', 'email'].map((field) => (
            <div key={field} className="space-y-1.5">
              <div className="bg-muted h-3 w-20 animate-pulse rounded" />
              <div className="bg-muted h-11 w-full animate-pulse rounded-lg" />
            </div>
          ))}
          <div className="bg-muted h-11 w-full animate-pulse rounded-lg" />
        </div>
      </div>
    </output>
  );
}
