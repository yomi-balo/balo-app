import { Archive } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * BAL-474 (R6F-2 / R6F-12) — THE ONE GLYPH FOR "THIS CASE WAS CLOSED BEFORE THE START". Shared by the waiting
 * stage's badge and the end-of-call card's mark so the two surfaces cannot drift.
 *
 * ⚠ STATIC AND NEUTRAL BY DESIGN: no spin (nothing is in progress) and no warning colour (nothing went wrong
 * that the viewer must act on). It carries no meaning on its own — the copy beside it states the situation.
 * Sizing is the caller's, through `className`.
 */
export function CaseClosedGlyph({
  className,
}: Readonly<{ className?: string }>): React.JSX.Element {
  return <Archive className={cn('text-muted-foreground', className)} aria-hidden="true" />;
}
