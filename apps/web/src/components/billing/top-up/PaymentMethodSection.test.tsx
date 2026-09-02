import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';

/**
 * A PaymentElement stand-in with a MOUNT COUNTER. This is the whole point of the file: the real
 * `@stripe/react-stripe-js@6.8.0` destroys the element on unmount (`dist/react-stripe.umd.js:
 * 666-676` — a `useLayoutEffect` cleanup calling `element.destroy()`, with no re-mount path), so
 * a second mount means the buyer's typed card digits were thrown away. The counter makes that
 * otherwise-invisible regression assertable.
 */
let mounts = 0;
vi.mock('@stripe/react-stripe-js', () => ({
  PaymentElement: ({ onReady }: { onReady?: () => void }) => {
    useEffect(() => {
      mounts += 1;
      onReady?.();
      // Deliberately NO cleanup that decrements: we count creations, not live instances.
    }, [onReady]);
    return <div data-testid="payment-element" />;
  },
}));

import { PaymentMethodSection } from './PaymentMethodSection';
import type { SavedCard } from './types';
import type { PaymentMethodSource } from '@/lib/credit/api-client';

const SAVED_CARD: SavedCard = {
  brand: 'visa',
  last4: '4242',
  expMonth: 8,
  expYear: 2028,
  mandateActive: false,
};

/** Render with the source held in a tiny harness, so "Change" really swaps the view. */
function renderSection(savedCard: SavedCard | null) {
  const onSourceChange = vi.fn();
  function Harness() {
    const [source, setSource] = useState<PaymentMethodSource>(
      savedCard === null ? 'new_card' : 'saved_card'
    );
    const handleSourceChange = (next: PaymentMethodSource): void => {
      onSourceChange(next);
      setSource(next);
    };
    return (
      <PaymentMethodSection
        savedCard={savedCard}
        source={source}
        onSourceChange={handleSourceChange}
      />
    );
  }
  render(<Harness />);
  return { onSourceChange };
}

describe('PaymentMethodSection', () => {
  beforeEach(() => {
    mounts = 0;
    vi.clearAllMocks();
  });

  it('does NOT mount the Payment Element when a saved card is shown (lazy)', () => {
    renderSection(SAVED_CARD);

    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
    expect(screen.getByText('Expires 08/28')).toBeInTheDocument();
    // No wasted Stripe iframe on the common path.
    expect(mounts).toBe(0);
    expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();
  });

  it('mounts the Element on "Change" and reports the new source', async () => {
    const { onSourceChange } = renderSection(SAVED_CARD);

    await userEvent.click(screen.getByRole('button', { name: /change/i }));

    expect(onSourceChange).toHaveBeenCalledWith('new_card');
    expect(mounts).toBe(1);
    expect(screen.getByTestId('payment-element')).toBeInTheDocument();
  });

  it('KEEPS the Element mounted (digits survive) when swapping back to the saved card', async () => {
    renderSection(SAVED_CARD);

    await userEvent.click(screen.getByRole('button', { name: /change/i }));
    expect(mounts).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: /keep visa •••• 4242 instead/i }));

    // Still exactly one creation — the node is HIDDEN, never unmounted.
    expect(mounts).toBe(1);
    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
  });

  it('never re-creates the Element across repeated swaps', async () => {
    renderSection(SAVED_CARD);

    await userEvent.click(screen.getByRole('button', { name: /change/i }));
    await userEvent.click(screen.getByRole('button', { name: /keep visa •••• 4242 instead/i }));
    await userEvent.click(screen.getByRole('button', { name: /change/i }));
    await userEvent.click(screen.getByRole('button', { name: /keep visa •••• 4242 instead/i }));
    await userEvent.click(screen.getByRole('button', { name: /change/i }));

    // A single creation across three "Change" presses. Any number > 1 means typed digits were
    // destroyed at least once — the regression this whole component is shaped to prevent.
    expect(mounts).toBe(1);
  });

  it('mounts the Element when the source is switched from OUTSIDE (not via "Change")', async () => {
    // ⚠ There are TWO routes to the new-card path and only one passes through this component:
    // the "Change" button, and `PayAction`'s post-decline "Use a different card", which flips
    // `source` in the composer. When the latch was owned by the local button, that second route
    // hid the saved-card row and mounted nothing — no card input anywhere. The latch therefore
    // follows the PROP, not the click.
    const onSourceChange = vi.fn();
    const { rerender } = render(
      <PaymentMethodSection
        savedCard={SAVED_CARD}
        source="saved_card"
        onSourceChange={onSourceChange}
      />
    );
    expect(mounts).toBe(0);

    rerender(
      <PaymentMethodSection
        savedCard={SAVED_CARD}
        source="new_card"
        onSourceChange={onSourceChange}
      />
    );

    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
    expect(mounts).toBe(1);
    // The saved-card row is gone, so the Element is the ONLY way to pay — it must be there.
    expect(screen.queryByText('Visa •••• 4242')).not.toBeInTheDocument();

    // …and it is still a ONE-WAY latch: swapping back hides, never unmounts.
    rerender(
      <PaymentMethodSection
        savedCard={SAVED_CARD}
        source="saved_card"
        onSourceChange={onSourceChange}
      />
    );
    expect(mounts).toBe(1);
  });

  it('mounts the Element immediately and offers no "keep" affordance with no saved card', () => {
    renderSection(null);

    expect(mounts).toBe(1);
    expect(screen.getByTestId('payment-element')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /instead/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change/i })).not.toBeInTheDocument();
  });

  it('shows the Stripe reassurance line and only ONE mandate disclosure (none here)', () => {
    renderSection(null);
    expect(screen.getByText(/Balo never sees your card number/i)).toBeInTheDocument();
    // The consent note lives with the mode picker, where consent is actually given.
    expect(screen.queryByText(/letting Balo charge/i)).not.toBeInTheDocument();
  });
});
