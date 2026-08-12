import { Users } from 'lucide-react';
import type { RecapNotHeldView } from '@/lib/meetings/recap-view-types';

/**
 * BAL-388 §R11 — the NOT-HELD panel. REPLACES summary / action items / transcript; the party
 * card, the files card and Rule M's money line all still render around it.
 *
 * ⚠ MJ COPY CHECKPOINT — all four cells (no-show × lens, missed-call × lens), plus the
 * URL-reachable `cancelled` case.
 *
 * ⚠ ONE SHARED HEADLINE, AND NO CTA. The meeting is the subject; the body carries who was
 * where. Every CTA the design considered here (book another time, offer a new time) has no
 * live destination today, so the panel renders none and must read complete without one —
 * never a disabled button.
 *
 * ⚠ NO MONEY PROSE. The design reference's no-show-policy sentences are DELETED, not reworded:
 * Rule M's single presence-keyed line in the meta row replaces both, and there is no
 * no-show-policy page to link to.
 */
export function NotHeldPanel({
  notHeld,
}: Readonly<{ notHeld: RecapNotHeldView }>): React.JSX.Element {
  return (
    <section className="bg-card border-border rounded-2xl border p-6 text-center shadow-sm">
      <span
        aria-hidden="true"
        className="bg-muted text-muted-foreground mb-3.5 inline-grid h-13 w-13 place-items-center rounded-xl"
      >
        <Users className="h-6 w-6" />
      </span>
      <h2 className="text-foreground text-[15px] font-semibold">{notHeld.headline}</h2>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-sm leading-relaxed">
        {notHeld.body}
      </p>
    </section>
  );
}
