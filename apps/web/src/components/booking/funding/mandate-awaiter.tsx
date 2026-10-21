'use client';

import { useEffect, useRef } from 'react';
import { useMandateActivePoll } from './use-mandate-active-poll';

interface MandateAwaiterProps {
  /** The wallet reports an active mandate. */
  readonly onActive: () => void;
  /** The wallet reports the card's setup failed. */
  readonly onFailed: () => void;
  /** The poll window closed, or the read was refused, without the mandate being seen active. */
  readonly onUnconfirmed: () => void;
}

/**
 * Hosts the mandate poll for the Pay-after block and renders nothing. Each callback fires at most
 * once, on the poll's transition out of `pending`. Mount a new instance (a new `key`) to ask
 * again.
 */
export function MandateAwaiter({
  onActive,
  onFailed,
  onUnconfirmed,
}: Readonly<MandateAwaiterProps>): null {
  const status = useMandateActivePoll();
  const reportedRef = useRef(false);

  useEffect(() => {
    if (reportedRef.current || status === 'pending') return;
    reportedRef.current = true;
    if (status === 'active') onActive();
    else if (status === 'failed') onFailed();
    else onUnconfirmed();
  }, [status, onActive, onFailed, onUnconfirmed]);

  return null;
}
