/**
 * BAL-442 — the resume segment's loading state.
 *
 * ⚠ THE PARENT `m/[meetingId]/` BOUNDARIES WOULD TECHNICALLY COVER THIS CHILD, but the
 * lobby's own skeleton mirrors a FORM — it would promise a form that never appears here. This
 * segment's own skeleton is shaped like the resume card instead.
 *
 * ⚠ `<output>`, NOT `role="status"` — SonarCloud S6819 flags the ARIA role where a native
 * element exists, and it escapes local lint (memory
 * `reference_sonarcloud_void_and_output_rules_missed_locally`). The `sr-only` line is what a
 * screen reader announces; the skeleton is decorative.
 *
 * ⚠⚠ `aria-busy` SITS ON THE **DECORATIVE WRAPPER**, NEVER ON THE ELEMENT CARRYING THE
 * `sr-only` TEXT — the same rule as the lobby's own `loading.tsx`.
 */
export default function LobbyResumeLoading(): React.JSX.Element {
  return (
    <output className="mx-auto block w-full max-w-md">
      <span className="sr-only">Loading…</span>
      <div
        aria-busy="true"
        className="border-border bg-card w-full rounded-2xl border p-8 text-center shadow-sm"
      >
        <div className="bg-muted mx-auto h-12 w-12 animate-pulse rounded-2xl" />
        <div className="bg-muted mx-auto mt-4 h-6 w-2/3 animate-pulse rounded" />
      </div>
    </output>
  );
}
