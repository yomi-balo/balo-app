const FOCUSABLE_SELECTOR =
  'input, textarea, select, button, [contenteditable="true"], [contenteditable=""]';
const FOCUS_DELAY_MS = 380;
const FLASH_DURATION_MS = 1400;

const clearTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function prefersReducedMotion(): boolean {
  return (
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** The element itself when it takes focus, else its first focusable descendant. */
function focusTargetOf(element: HTMLElement): HTMLElement {
  if (element.matches(FOCUSABLE_SELECTOR)) return element;
  return element.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? element;
}

/**
 * Restart the field-flash highlight on the target's `[data-flash]` ancestor, if any, and
 * clear it once the flash window has elapsed (under reduced motion the class is a static cue).
 */
function flash(element: HTMLElement): void {
  const box = element.closest('[data-flash]');
  if (box === null) return;
  box.classList.remove('animate-field-flash');
  // Reading layout forces a reflow so re-adding the class restarts the animation.
  box.getBoundingClientRect();
  box.classList.add('animate-field-flash');
  const pending = clearTimers.get(box);
  if (pending !== undefined) clearTimeout(pending);
  clearTimers.set(
    box,
    setTimeout(() => box.classList.remove('animate-field-flash'), FLASH_DURATION_MS)
  );
}

/**
 * Scroll to a composer field, flash its highlight box and move focus into it.
 * Returns false when no element carries the id. A target with no `[data-flash]`
 * ancestor (the add-row buttons) is focused without a flash. Reduced motion
 * scrolls instantly and focuses immediately.
 */
export function jumpToField(id: string): boolean {
  const element = document.getElementById(id);
  if (element === null) return false;
  const reduced = prefersReducedMotion();
  element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  flash(element);
  setTimeout(
    () => {
      focusTargetOf(element).focus({ preventScroll: true });
    },
    reduced ? 0 : FOCUS_DELAY_MS
  );
  return true;
}
