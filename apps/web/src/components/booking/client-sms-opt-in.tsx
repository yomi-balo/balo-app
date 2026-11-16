'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageSquareText } from 'lucide-react';
import { BaloCard } from '@/components/balo/card/balo-card';
import { PhoneVerificationFlow } from '@/components/balo/phone-verification-flow';
import { Button } from '@/components/ui/button';
import { track, PHONE_EVENTS } from '@/lib/analytics';
import {
  getClientSmsConsentStateAction,
  setClientSmsConsentAction,
} from '@/lib/phone/client-sms-consent-actions';
import { formatPhoneForDisplay } from '@/lib/phone/format';
import type {
  ClientSmsConsentMethod,
  ClientSmsConsentState,
  ClientSmsOptInSurface,
} from '@/lib/phone/types';

type View =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'offer'; verifiedPhone: string | null }
  | { kind: 'verify'; verifiedPhone: string | null }
  | { kind: 'failed'; phone: string; method: ClientSmsConsentMethod }
  | { kind: 'done'; phone: string };

export interface ClientSmsOptInProps {
  surface: ClientSmsOptInSurface;
  expertFirstName: string | null;
}

const FAILURE_MESSAGE = "We couldn't turn on text alerts — please try again.";
const SUCCESS_MESSAGE = 'Text alerts are on.';

function viewFromState(state: ClientSmsConsentState): View {
  if (state.status === 'not_opted_in') {
    return { kind: 'offer', verifiedPhone: state.verifiedPhone };
  }
  return { kind: 'hidden' };
}

/**
 * BAL-655 — optional "text me when my expert is ready" card on a booking confirmation. It loads
 * its own consent state, so neither booking dialog nor booking action changes, and it never
 * disables or wraps the booked step's own buttons. One click consents on an already-verified
 * number; otherwise the OTP flow verifies a number first. Hidden while unavailable, once opted in,
 * and for the rest of this mount after "No thanks".
 */
export function ClientSmsOptIn({
  surface,
  expertFirstName,
}: Readonly<ClientSmsOptInProps>): React.JSX.Element | null {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [pending, setPending] = useState(false);
  const shownTracked = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getClientSmsConsentStateAction()
      .then((state) => {
        if (!cancelled) setView(viewFromState(state));
      })
      .catch(() => {
        if (!cancelled) setView({ kind: 'hidden' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const offeredPhone = view.kind === 'offer' ? view.verifiedPhone : undefined;
  const isOffer = view.kind === 'offer';
  useEffect(() => {
    if (!isOffer || shownTracked.current) return;
    shownTracked.current = true;
    track(PHONE_EVENTS.CLIENT_SMS_OPT_IN_SHOWN, {
      surface,
      has_verified_phone: offeredPhone !== null,
    });
  }, [isOffer, offeredPhone, surface]);

  const consent = useCallback(
    async (
      phone: string,
      method: ClientSmsConsentMethod,
      verifiedPhone: string | null
    ): Promise<void> => {
      setPending(true);
      try {
        const result = await setClientSmsConsentAction({ optedIn: true, surface });
        if (result.ok) {
          track(PHONE_EVENTS.CLIENT_SMS_OPT_IN_COMPLETED, { surface, method });
          toast.success(SUCCESS_MESSAGE);
          setView({ kind: 'done', phone });
          return;
        }
        if (result.code === 'phone_not_verified' && method === 'existing_number') {
          setView({ kind: 'verify', verifiedPhone });
          return;
        }
        toast.error(FAILURE_MESSAGE);
        setView({ kind: 'failed', phone, method });
      } catch {
        toast.error(FAILURE_MESSAGE);
        setView({ kind: 'failed', phone, method });
      } finally {
        setPending(false);
      }
    },
    [surface]
  );

  const handleVerified = useCallback(
    (e164: string): void => {
      consent(e164, 'new_number', null).catch(() => undefined);
    },
    [consent]
  );

  const handleOfferPrimary = useCallback((): void => {
    if (view.kind !== 'offer') return;
    if (view.verifiedPhone === null) {
      setView({ kind: 'verify', verifiedPhone: null });
      return;
    }
    consent(view.verifiedPhone, 'existing_number', view.verifiedPhone).catch(() => undefined);
  }, [consent, view]);

  const handleUseDifferent = useCallback((): void => {
    if (view.kind !== 'offer') return;
    setView({ kind: 'verify', verifiedPhone: view.verifiedPhone });
  }, [view]);

  const handleBackToOffer = useCallback((): void => {
    if (view.kind !== 'verify') return;
    setView({ kind: 'offer', verifiedPhone: view.verifiedPhone });
  }, [view]);

  const handleDecline = useCallback((): void => {
    setView({ kind: 'hidden' });
  }, []);

  const handleRetry = useCallback((): void => {
    if (view.kind !== 'failed') return;
    consent(view.phone, view.method, view.phone).catch(() => undefined);
  }, [consent, view]);

  const name = expertFirstName ?? 'your expert';

  if (view.kind === 'hidden') return null;

  if (view.kind === 'loading') {
    return (
      <output
        aria-busy="true"
        className="bg-muted/50 block h-24 w-full max-w-[360px] animate-pulse rounded-2xl"
      >
        <span className="sr-only">Loading text alert options</span>
      </output>
    );
  }

  if (view.kind === 'done') {
    return (
      <output className="text-success block text-sm font-medium">
        You&apos;re all set — we&apos;ll text {formatPhoneForDisplay(view.phone)}.
      </output>
    );
  }

  if (view.kind === 'verify') {
    return (
      <BaloCard className="w-full max-w-[360px] p-4 text-left">
        <p className="text-foreground mb-3 text-sm font-semibold">Text me when {name} is ready</p>
        <PhoneVerificationFlow
          mode="settings"
          audience="client"
          onVerified={handleVerified}
          onCancel={handleBackToOffer}
          focusOnMount
        />
      </BaloCard>
    );
  }

  const isFailed = view.kind === 'failed';
  let primaryLabel = 'Add my mobile';
  if (view.kind === 'failed') {
    primaryLabel = 'Try again';
  } else if (view.verifiedPhone !== null) {
    primaryLabel = `Text me at ${formatPhoneForDisplay(view.verifiedPhone)}`;
  }

  return (
    <BaloCard className="w-full max-w-[360px] p-4 text-left">
      <div className="flex items-start gap-3">
        <span
          className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full"
          aria-hidden="true"
        >
          <MessageSquareText className="size-4" />
        </span>
        <div className="min-w-0 space-y-1">
          <h3 className="text-foreground text-sm font-semibold">Text me when {name} is ready</h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {isFailed
              ? `We verified ${formatPhoneForDisplay(view.phone)} but couldn't turn on texts yet.`
              : 'One quick text to your mobile when it’s time to join. Turn it off any time in Account.'}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={isFailed ? handleRetry : handleOfferPrimary}
          disabled={pending}
          className="min-h-11"
        >
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {primaryLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDecline}
          disabled={pending}
          className="min-h-11"
        >
          No thanks
        </Button>
      </div>
      {view.kind === 'offer' && view.verifiedPhone !== null && (
        <Button
          variant="link"
          size="sm"
          onClick={handleUseDifferent}
          disabled={pending}
          className="mt-1 h-auto min-h-11 px-0"
        >
          Use a different number
        </Button>
      )}
    </BaloCard>
  );
}
