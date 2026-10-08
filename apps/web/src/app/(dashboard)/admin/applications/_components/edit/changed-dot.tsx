/**
 * BAL-593 §[F] — the 8px primary dot that marks a field, row or chip changed from the locked
 * snapshot. Design ref 681-698.
 *
 * `role="img"` on a plain decorative dot is a
 * misleading semantic (no image content exists to describe); the dot is now `aria-hidden` and a
 * visually-hidden `<span>` carries the same label to assistive tech, so the mark still reads to a
 * screen reader instead of vanishing as decoration.
 */
export function ChangedDot(): React.JSX.Element {
  return (
    <>
      <span
        aria-hidden="true"
        title="Changed in this edit"
        className="bg-primary inline-block size-2 shrink-0 rounded-full"
      />
      <span className="sr-only">Changed in this edit</span>
    </>
  );
}
