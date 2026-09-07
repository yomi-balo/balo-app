/**
 * Shared "first letter of up to the first two words" initials shape.
 *
 * ⚠ EXTRACTED BY BAL-541 (F8 fix-round). This exact body was duplicated across THREE modules —
 * `admin-health-panel.tsx` (the original), `load-balo-panel.ts` (a server-only loader, which
 * couldn't import the client-only original), and `pipeline-kanban.tsx` (the newest copy, same
 * reason) — each with a docblock apologising for the copy. One home, beside `relative-time.ts`.
 *
 * ⚠ NOT a replacement for `lib/search/expert-card-mapper.ts`'s `deriveInitials` — that one uses a
 * DIFFERENT algorithm (first + last token, not first two tokens) for a different surface and is
 * intentionally left alone.
 */
export function deriveInitials(name: string): string {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}
