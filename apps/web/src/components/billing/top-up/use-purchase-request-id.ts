'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * The client half of a purchase's idempotency key: stable across double-submits of the SAME
 * configuration, regenerated when the configuration changes.
 *
 * Held in a ref keyed by a signature (a lint-clean derived value — no hook deps array), so a
 * re-render with the same configuration reuses the same UUID and a double-click returns the
 * same PaymentIntent.
 *
 * ⚠ `configSignature` MUST INCLUDE EVERYTHING THAT CHANGES THE PaymentIntent's PARAMS — the amount,
 * mode, promo, reload, threshold and the PAYMENT-METHOD SOURCE. The two sources build
 * PaymentIntents with DIFFERENT params (one carries `payment_method` + `confirm: true`), and
 * Stripe 400s on the same idempotency key with different params — so without the source in the
 * signature, Pay would die permanently the moment a buyer pressed "Change".
 *
 * ⚠ `rotate` IS THE DECLINE NONCE. Stripe caches a 402 `card_declined` against the key (the
 * endpoint DID execute), so retrying the same configuration replays the cached decline for 24h
 * without ever contacting the issuer — `insufficient_funds` and try-again-later declines would be
 * permanent for this amount/card. The owner of the key calls `rotate` on every proven
 * non-completion, so the next Pay press is a genuinely new attempt.
 */
export function usePurchaseRequestId(configSignature: string): {
  readonly clientRequestId: string;
  readonly rotate: () => void;
} {
  const [declineNonce, setDeclineNonce] = useState(0);
  const signature = `${configSignature}:${declineNonce}`;
  const requestIdRef = useRef({ signature, id: globalThis.crypto.randomUUID() });
  if (requestIdRef.current.signature !== signature) {
    requestIdRef.current = { signature, id: globalThis.crypto.randomUUID() };
  }
  const rotate = useCallback(() => setDeclineNonce((n) => n + 1), []);
  return { clientRequestId: requestIdRef.current.id, rotate };
}
