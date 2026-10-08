/**
 * BAL-593 §[F] — the 8px primary dot that marks a field, row or chip changed from the locked
 * snapshot. Design ref 681-698. `role="img"` + `aria-label` so the mark reads to a screen reader
 * instead of vanishing as decoration; the visible dot carries no text of its own.
 */
export function ChangedDot(): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label="Changed in this edit"
      title="Changed in this edit"
      className="bg-primary inline-block size-2 shrink-0 rounded-full"
    />
  );
}
