// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { guardStripeOutsideInteraction, isStripeFrameTarget } from './stripe-outside-guard';

function frame(attributes: Record<string, string>): HTMLIFrameElement {
  const element = document.createElement('iframe');
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

function outside(target: EventTarget | null): {
  target: EventTarget | null;
  preventDefault: () => void;
} {
  return { target, preventDefault: vi.fn() };
}

describe('isStripeFrameTarget', () => {
  it('recognises a frame Stripe.js injected, by name or by origin', () => {
    expect(isStripeFrameTarget(frame({ name: '__privateStripeFrame5' }))).toBe(true);
    expect(
      isStripeFrameTarget(frame({ src: 'https://js.stripe.com/v3/three-ds-2-challenge' }))
    ).toBe(true);
  });

  it('ignores any other element, frame or target', () => {
    expect(isStripeFrameTarget(frame({ name: 'video', src: 'https://example.com' }))).toBe(false);
    expect(isStripeFrameTarget(document.createElement('button'))).toBe(false);
    expect(isStripeFrameTarget(null)).toBe(false);
    expect(isStripeFrameTarget(globalThis.window)).toBe(false);
  });
});

describe('guardStripeOutsideInteraction', () => {
  it('keeps the modal open for an interaction with a Stripe frame, even when idle', () => {
    const event = outside(frame({ name: '__privateStripeFrame9' }));
    guardStripeOutsideInteraction(false)(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('keeps the modal open for any outside interaction while something is in flight', () => {
    const event = outside(document.createElement('div'));
    guardStripeOutsideInteraction(true)(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('lets an ordinary outside interaction through while idle', () => {
    const event = outside(document.createElement('div'));
    guardStripeOutsideInteraction(false)(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
