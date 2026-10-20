'use client';

import { useEffect, useRef } from 'react';
import { useTopUpCreditPoll } from '@/components/billing/top-up/use-topup-credit-poll';

interface CreditAwaiterProps {
  readonly paymentIntentId: string;
  readonly promoCodeId: string | null;
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
  onCredited,
  onUnconfirmed,
}: Readonly<CreditAwaiterProps>): null {
  const { status, promoGranted } = useTopUpCreditPoll(paymentIntentId, promoCodeId);
  const reportedRef = useRef(false);

  useEffect(() => {
    if (reportedRef.current || status === 'pending') return;
    reportedRef.current = true;
    if (status === 'credited') onCredited(promoGranted === true);
    else onUnconfirmed();
  }, [status, promoGranted, onCredited, onUnconfirmed]);

  return null;
}
