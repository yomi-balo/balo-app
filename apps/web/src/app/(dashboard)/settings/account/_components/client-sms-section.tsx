'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { BaloCard } from '@/components/balo/card/balo-card';
import { PhoneVerificationFlow } from '@/components/balo/phone-verification-flow';
import { Button } from '@/components/ui/button';
import { track, PHONE_EVENTS } from '@/lib/analytics';
import { setClientSmsConsentAction } from '@/lib/phone/client-sms-consent-actions';
import { formatPhoneForDisplay } from '@/lib/phone/format';
import type { ClientSmsConsentMethod } from '@/lib/phone/types';

type Mode = 'idle' | 'change' | 'verify_new';

const ENABLE_FAILURE_MESSAGE = "We couldn't turn on text alerts — please try again.";
const DISABLE_FAILURE_MESSAGE = "We couldn't turn off text alerts — please try again.";

export interface ClientSmsSectionProps {
  /** The user's verified number, or null when none is verified. */
  verifiedPhone: string | null;
  /** Consent AND a verified number (the same rule `getClientSmsConsentStateAction` applies). */
  optedIn: boolean;
  /** Display-only: this number is also the one on the expert profile. */
  sharesExpertNumber: boolean;
}

/**
 * BAL-655 "Text alerts" — the account-level home of client SMS consent. Stopping texts clears only
 * the consent flag: the number and its verification stay (the expert profile reads them), so the
 * copy never claims the number was removed. Changing the number re-verifies through the same flow
 * and leaves consent as it was.
 */
export function ClientSmsSection({
  verifiedPhone,
  optedIn,
  sharesExpertNumber,
}: Readonly<ClientSmsSectionProps>): React.JSX.Element {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [pending, setPending] = useState(false);

  const enable = useCallback(
    async (method: ClientSmsConsentMethod, phone: string): Promise<void> => {
      setPending(true);
      try {
        const result = await setClientSmsConsentAction({
          optedIn: true,
          surface: 'account_settings',
        });
        if (!result.ok) {
          toast.error(ENABLE_FAILURE_MESSAGE);
          if (method === 'new_number') {
            setMode('idle');
            router.refresh();
          }
          return;
        }
        track(PHONE_EVENTS.CLIENT_SMS_OPT_IN_COMPLETED, { surface: 'account_settings', method });
        toast.success(`Text alerts are on for ${formatPhoneForDisplay(phone)}.`);
        setMode('idle');
        router.refresh();
      } catch {
        toast.error(ENABLE_FAILURE_MESSAGE);
      } finally {
        setPending(false);
      }
    },
    [router]
  );

  const handleEnableExisting = useCallback((): void => {
    if (verifiedPhone === null) return;
    enable('existing_number', verifiedPhone).catch(() => undefined);
  }, [enable, verifiedPhone]);

  const handleNewNumberVerified = useCallback(
    (e164: string): void => {
      enable('new_number', e164).catch(() => undefined);
    },
    [enable]
  );

  const handleChangeVerified = useCallback((): void => {
    setMode('idle');
    toast.success('Number updated.');
    router.refresh();
  }, [router]);

  const handleStop = useCallback(async (): Promise<void> => {
    setPending(true);
    try {
      const result = await setClientSmsConsentAction({
        optedIn: false,
        surface: 'account_settings',
      });
      if (!result.ok) {
        toast.error(DISABLE_FAILURE_MESSAGE);
        return;
      }
      track(PHONE_EVENTS.CLIENT_SMS_OPT_IN_REMOVED, { surface: 'account_settings' });
      toast.success('Text alerts are off. You can turn them back on any time.');
      router.refresh();
    } catch {
      toast.error(DISABLE_FAILURE_MESSAGE);
    } finally {
      setPending(false);
    }
  }, [router]);

  const handleStopClick = useCallback((): void => {
    handleStop().catch(() => undefined);
  }, [handleStop]);

  const showChange = useCallback((): void => setMode('change'), []);
  const showVerifyNew = useCallback((): void => setMode('verify_new'), []);
  const showIdle = useCallback((): void => setMode('idle'), []);

  return (
    <BaloCard className="p-6">
      <div className="flex items-center gap-2">
        <h2 className="text-foreground text-sm font-semibold">Text alerts</h2>
        {optedIn && (
          <span className="bg-success/15 text-success rounded-full px-2 py-0.5 text-xs font-medium">
            On
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Get a text when your expert is ready to join, and for time-sensitive updates on a live
        session.
      </p>

      <div className="mt-4">
        {mode === 'change' && verifiedPhone !== null && (
          <PhoneVerificationFlow
            mode="settings"
            audience="client"
            initialPhone={verifiedPhone}
            onVerified={handleChangeVerified}
            onCancel={showIdle}
            focusOnMount
          />
        )}

        {mode === 'verify_new' && (
          <PhoneVerificationFlow
            mode="settings"
            audience="client"
            onVerified={handleNewNumberVerified}
            onCancel={showIdle}
            focusOnMount
          />
        )}

        {mode === 'idle' && optedIn && verifiedPhone !== null && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-foreground text-sm font-medium">
              {formatPhoneForDisplay(verifiedPhone)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={showChange}
                disabled={pending}
              >
                Change number
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11"
                onClick={handleStopClick}
                disabled={pending}
              >
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                Stop texts
              </Button>
            </div>
          </div>
        )}

        {mode === 'idle' && !optedIn && verifiedPhone !== null && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="min-h-11"
              onClick={handleEnableExisting}
              disabled={pending}
            >
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              Text me at {formatPhoneForDisplay(verifiedPhone)}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              onClick={showVerifyNew}
              disabled={pending}
            >
              Use a different number
            </Button>
          </div>
        )}

        {mode === 'idle' && !optedIn && verifiedPhone === null && (
          <PhoneVerificationFlow
            mode="settings"
            audience="client"
            onVerified={handleNewNumberVerified}
            focusOnMount={false}
          />
        )}
      </div>

      {sharesExpertNumber && verifiedPhone !== null && (
        <p className="text-muted-foreground mt-3 text-xs">
          This is also the number on your expert profile.
        </p>
      )}
    </BaloCard>
  );
}
