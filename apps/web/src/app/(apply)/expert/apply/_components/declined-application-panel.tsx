'use client';

import { useCallback, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { startNewApplicationAction } from '../_actions/start-new-application';
import {
  DECLINED_PANEL_COPY,
  REOPENED_TOAST,
  REOPEN_GENERIC_ERROR,
  reopenCooldownError,
} from '../_actions/declined-application-copy';

/**
 * BAL-557 — the surface that REPLACES the wizard while the application is `rejected`.
 * Receives only a pre-formatted date string (or `null`) and a boolean — never `declineReason`,
 * `decidedAt`, `decidedByUserId` or `declineNote` (the PII rule). Never value-imports `@balo/db`
 * or the web logger (client-bundle rule).
 *
 * Four async states: idle/ready (enabled CTA), idle/cooldown (disabled CTA + date), pending
 * (spinner + `aria-busy`, label kept), and error (toast + inline `role="alert"` text). A
 * `cooldown_active` RESULT (the cooldown changed, or expired, between render and click) flips
 * the panel to the cooldown arm using the server's own date — never a client-computed one.
 */

interface DeclinedApplicationPanelProps {
  readonly reapplyAvailableOn: string | null;
  readonly canStartNow: boolean;
}

export function DeclinedApplicationPanel({
  reapplyAvailableOn,
  canStartNow: initialCanStartNow,
}: Readonly<DeclinedApplicationPanelProps>): React.JSX.Element {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [canStartNow, setCanStartNow] = useState(initialCanStartNow);
  const [availableOn, setAvailableOn] = useState(reapplyAvailableOn);
  const [error, setError] = useState<string | null>(null);
  const availabilityId = useId();

  const handleStart = useCallback((): void => {
    setError(null);
    setIsPending(true);

    const run = async (): Promise<void> => {
      try {
        const result = await startNewApplicationAction();

        if (result.success) {
          toast.success(REOPENED_TOAST);
          router.refresh();
          return;
        }

        if (result.code === 'cooldown_active') {
          setCanStartNow(false);
          setAvailableOn(result.availableOn);
          setError(reopenCooldownError(result.availableOn));
          toast.error(result.error);
          return;
        }

        setError(result.error);
        toast.error(result.error);
      } catch (err: unknown) {
        Sentry.captureException(err);
        setError(REOPEN_GENERIC_ERROR);
        toast.error(REOPEN_GENERIC_ERROR);
      } finally {
        setIsPending(false);
      }
    };
    run().catch((err: unknown) => Sentry.captureException(err));
  }, [router]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 py-12">
      <Card>
        <CardContent className="flex flex-col gap-4 p-6 sm:p-8">
          <h1 className="text-foreground text-xl font-semibold">{DECLINED_PANEL_COPY.heading}</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {canStartNow ? DECLINED_PANEL_COPY.bodyReady : DECLINED_PANEL_COPY.bodyCooldown}
          </p>

          <p id={availabilityId} className="text-foreground text-sm font-medium">
            {canStartNow
              ? DECLINED_PANEL_COPY.readyNow
              : DECLINED_PANEL_COPY.availableFrom(availableOn ?? '')}
          </p>

          {error !== null && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          <div>
            <Button
              type="button"
              onClick={handleStart}
              disabled={!canStartNow || isPending}
              aria-busy={isPending}
              aria-describedby={availabilityId}
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
              )}
              {DECLINED_PANEL_COPY.ctaLabel}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
