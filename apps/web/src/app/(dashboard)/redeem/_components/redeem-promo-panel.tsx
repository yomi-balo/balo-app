'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { Gift, Loader2, PartyPopper, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { redeemPromoCode, type RedeemPromoActionResult } from '../_actions/redeem-promo';
import { ContinueToMandate } from './continue-to-mandate';

/**
 * RedeemPromoPanel — the standalone redeem surface (BAL-383). One shared form with all
 * four states: idle (an invitation to redeem, never "no code yet"), loading (submit
 * spinner via `useTransition`), success (a warm milestone card + the Model-C continue
 * hand-off), and every warm refusal (expired / scheduled / deactivated / exhausted /
 * not-found / forbidden) rendered as non-adversarial inline copy. Toast fires on the
 * successful mutation. No `@balo/db` value import — the Server Action owns all data
 * access; this component only imports the action + serialisable result type.
 */

interface RedeemPromoPanelProps {
  readonly companyName: string;
  readonly companyId: string;
}

type RefusalStatus = 'not_found' | 'scheduled' | 'expired' | 'deactivated' | 'exhausted' | 'error';

const REFUSAL_COPY: Record<RefusalStatus, { title: string; body: string }> = {
  not_found: {
    title: "We couldn't find that code",
    body: 'Check the spelling and try again.',
  },
  scheduled: {
    title: "This code isn't active yet",
    body: "It hasn't started yet — try again once it's live.",
  },
  expired: {
    title: 'This code has expired',
    body: 'Its redemption window has closed.',
  },
  deactivated: {
    title: 'This code is no longer available',
    body: 'It has been turned off.',
  },
  exhausted: {
    title: 'This code has been fully claimed',
    body: 'Every redemption for this code has already been used.',
  },
  error: {
    title: 'Something went wrong on our side',
    body: 'Nothing was charged or changed. Please try again in a moment.',
  },
};

const FEEDBACK_ID = 'promo-redeem-feedback';
const HINT_ID = 'promo-redeem-hint';

/** The warm inline feedback shown beneath the form for a refusal / error / forbidden. */
function RedeemFeedback({
  result,
  companyName,
}: Readonly<{ result: RedeemPromoActionResult; companyName: string }>): React.JSX.Element | null {
  if (result.status === 'redeemed') {
    return null;
  }
  const isError = result.status === 'error';
  const copy =
    result.status === 'forbidden'
      ? {
          title: "You don't have permission to redeem",
          body: `Ask an owner or admin to redeem for ${companyName}.`,
        }
      : REFUSAL_COPY[result.status];

  return (
    <div
      role="alert"
      id={FEEDBACK_ID}
      className={
        isError
          ? 'border-destructive/25 bg-destructive/10 mt-4 rounded-lg border px-4 py-3'
          : 'border-border bg-muted/40 mt-4 rounded-lg border px-4 py-3'
      }
    >
      <p
        className={
          isError ? 'text-destructive text-sm font-medium' : 'text-foreground text-sm font-medium'
        }
      >
        {copy.title}
      </p>
      <p className="text-muted-foreground mt-0.5 text-sm">{copy.body}</p>
    </div>
  );
}

/** The warm "redeem another code" affordance, shared by the success and redirect-return views. */
function RedeemAnotherButton({ onClick }: Readonly<{ onClick: () => void }>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-primary focus-visible:ring-ring mx-auto inline-flex min-h-[44px] items-center gap-1.5 rounded py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
      Redeem another code
    </button>
  );
}

/**
 * Detect a 3DS/SCA return from Stripe mandate setup. A card that needs authentication
 * redirects the browser away and back to /redeem with the SetupIntent params appended,
 * after the redeem success state has been lost to the full-page redirect.
 */
function isRedirectReturn(): boolean {
  const params = new URLSearchParams(globalThis.location.search);
  return (
    params.get('setup_intent_client_secret') !== null ||
    (params.get('setup_intent') !== null && params.get('redirect_status') !== null)
  );
}

export function RedeemPromoPanel({
  companyName,
  companyId,
}: Readonly<RedeemPromoPanelProps>): React.JSX.Element {
  const [code, setCode] = useState('');
  const [result, setResult] = useState<RedeemPromoActionResult | null>(null);
  const [redirectReturn, setRedirectReturn] = useState(false);
  const [isPending, startTransition] = useTransition();

  // On a 3DS/SCA return the redeem success state is gone (full-page redirect), so surface
  // the continue-to-mandate confirmation directly; ContinueToMandate retrieves the
  // SetupIntent and confirms the saved card. Detected post-mount to avoid a hydration
  // mismatch on the server-rendered idle form.
  useEffect(() => {
    if (isRedirectReturn()) {
      setRedirectReturn(true);
    }
  }, []);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const trimmed = code.trim();
      if (trimmed.length === 0 || isPending) {
        return;
      }
      startTransition(async () => {
        const res = await redeemPromoCode({ code: trimmed });
        setResult(res);
        if (res.status === 'redeemed') {
          toast.success(
            res.alreadyRedeemed
              ? `This code was already redeemed for ${companyName}.`
              : `${res.grantedLabel} added to ${companyName}.`
          );
        }
      });
    },
    [code, isPending, companyName]
  );

  const handleRedeemAnother = useCallback((): void => {
    setResult(null);
    setCode('');
    setRedirectReturn(false);
  }, []);

  const hasRefusal = result !== null && result.status !== 'redeemed';

  // ── Success state ──
  if (result?.status === 'redeemed') {
    const { alreadyRedeemed, grantedLabel, balanceLabel } = result;
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mx-auto flex w-full max-w-lg flex-col gap-5"
      >
        <div className="border-success/30 bg-success/5 rounded-2xl border p-6 text-center">
          <div className="bg-success/10 mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full">
            <PartyPopper className="text-success h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-foreground text-xl font-semibold">
            {alreadyRedeemed ? 'Already redeemed' : "You're all set"}
          </h1>
          <p className="text-muted-foreground mx-auto mt-1.5 max-w-sm text-sm leading-relaxed">
            {alreadyRedeemed
              ? `This code was already redeemed for ${companyName}. Nothing was added twice.`
              : `${grantedLabel} added to ${companyName} — it's ready to use whenever you are.`}
          </p>
          {balanceLabel !== null && (
            <p className="text-foreground mt-3 font-mono text-lg font-semibold tabular-nums">
              {balanceLabel}
              <span className="text-muted-foreground ml-1.5 font-sans text-xs font-normal">
                balance
              </span>
            </p>
          )}
        </div>

        <ContinueToMandate companyId={companyId} />

        <RedeemAnotherButton onClick={handleRedeemAnother} />
      </motion.div>
    );
  }

  // ── 3DS/SCA redirect-return confirmation (the fresh redeem result is gone) ──
  if (redirectReturn) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mx-auto flex w-full max-w-lg flex-col gap-5"
      >
        <ContinueToMandate companyId={companyId} />
        <RedeemAnotherButton onClick={handleRedeemAnother} />
      </motion.div>
    );
  }

  // ── Idle / loading / refusal / error state ──
  return (
    <div className="mx-auto w-full max-w-lg">
      <div className="border-border bg-card rounded-2xl border p-6">
        <div className="mb-5 flex items-start gap-3">
          <div className="bg-primary/10 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
            <Gift className="text-primary h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-foreground text-lg font-semibold">Redeem a promo code</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Have a promo code? Add the credit to {companyName} — no card needed.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="promo-redeem-code">Promo code</Label>
            <Input
              id="promo-redeem-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setResult(null);
              }}
              placeholder="WELCOME50"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              maxLength={64}
              disabled={isPending}
              aria-invalid={hasRefusal}
              aria-describedby={hasRefusal ? `${HINT_ID} ${FEEDBACK_ID}` : HINT_ID}
            />
            <p id={HINT_ID} className="text-muted-foreground text-xs">
              Codes aren&apos;t case-sensitive.
            </p>
          </div>

          <Button type="submit" disabled={isPending || code.trim().length === 0} className="w-full">
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Redeeming…
              </>
            ) : (
              'Redeem'
            )}
          </Button>
        </form>

        {result !== null && <RedeemFeedback result={result} companyName={companyName} />}
      </div>
    </div>
  );
}
