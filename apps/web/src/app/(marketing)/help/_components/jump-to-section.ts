import { track, HELP_EVENTS } from '@/lib/analytics';

/**
 * Scrolls to `#step-<n>`, moves focus to it, records it in the URL and tracks the jump. Shared by the desktop rail and
 * the mobile list so both behave and report identically. Smooth scrolling is skipped for readers
 * who prefer reduced motion.
 */
export function jumpToSection(slug: string, n: number): void {
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const target = document.getElementById(`step-${n}`);
  target?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  target?.focus({ preventScroll: true });
  globalThis.history.replaceState(null, '', `#step-${n}`);
  track(HELP_EVENTS.SECTION_JUMPED, { slug, section: n });
}
