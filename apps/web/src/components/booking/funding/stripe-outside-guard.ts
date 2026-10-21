/**
 * Stripe mounts its own frames (the 3DS challenge, Link's pop-up) on `document.body`, outside the
 * booking Dialog or Sheet. Radix reads a pointer-down or a focus move into one of them as an
 * interaction OUTSIDE the modal and dismisses it. Matched by the `__privateStripe` frame name
 * Stripe.js gives every frame it injects, and by the frame's Stripe origin.
 */
const STRIPE_FRAME_SELECTOR = 'iframe[name^="__privateStripe"], iframe[src*="stripe.com"]';

/** Whether an event target is, or sits inside, a frame Stripe.js injected. */
export function isStripeFrameTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(STRIPE_FRAME_SELECTOR) !== null;
}

interface OutsideInteraction {
  readonly target: EventTarget | null;
  preventDefault(): void;
}

/**
 * Builds the `onInteractOutside` / `onPointerDownOutside` handler for the booking modal: an
 * interaction with a Stripe frame never dismisses it, and nothing outside does while a charge,
 * the wait for its credit or the booking after it is in flight.
 */
export function guardStripeOutsideInteraction(
  inFlight: boolean
): (event: OutsideInteraction) => void {
  return (event) => {
    if (inFlight || isStripeFrameTarget(event.target)) event.preventDefault();
  };
}
