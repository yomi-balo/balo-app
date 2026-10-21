'use client';

import { useEffect, useRef } from 'react';
import { useTopUpCreditPoll } from '@/components/billing/top-up/use-topup-credit-poll';

interface CreditAwaiterProps {
  readonly paymentIntentId: string;
  readonly promoCodeId: string | null;
  /**
   * The purchase re-armed the wallet's mandate on a new card: wait for it to be live as well, so
   * the booking that follows does not read the gap before the SetupIntent's webhook lands.
   */
  readonly awaitMandate: boolean;
  /** The wallet carries this payment's ledger entry. `promoGranted` is `true` only if the bonus landed too. */
  readonly onCredited: (promoGranted: boolean) => void;
  /** The poll window closed, or the read was not permitted, without the credit being seen. */
  readonly onUnconfirmed: () => void;
}

/**
 * Hosts the top-up credit poll for the funding block and renders nothing.
 *
 * The wallet answers whether the credit landed; a Stripe return is never treated as credit. Each
 * callback fires at most once, on the poll's transition out of `pending`. Mount a new instance
 * (a new `key`) to ask again.
 */
export function CreditAwaiter({
  paymentIntentId,
  promoCodeId,
  awaitMandate,
  onCredited,
  onUnconfirmed,
}: Readonly<CreditAwaiterProps>): null {
  const { status, promoGranted } = useTopUpCreditPoll(paymentIntentId, promoCodeId, {
    awaitMandate,
  });
  const reportedRef = useRef(false);

  useEffect(() => {
    if (reportedRef.current || status === 'pending') return;
    reportedRef.current = true;
    if (status === 'credited') onCredited(promoGranted === true);
    else onUnconfirmed();
  }, [status, promoGranted, onCredited, onUnconfirmed]);

  return null;
}
