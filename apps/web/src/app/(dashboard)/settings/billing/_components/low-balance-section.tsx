'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  LowBalanceModePicker,
  CARD_BACKED_MODE_TITLE,
} from '@/components/billing/top-up/LowBalanceModePicker';
import { autoTopupConfigErrors } from '@/lib/credit/display-constants';
import type { LowBalanceMode } from '@/lib/credit/actions';
import { armSavedCardMandateAction, saveLowBalanceConfigAction } from '@/lib/credit/actions';
import { isCardBackedLowBalanceMode, type CardBackedLowBalanceMode } from '@balo/shared/credit';
import { getStripe } from '@/lib/stripe-loader';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';

export interface LowBalanceDraft {
  mode: LowBalanceMode;
  reloadMinor: number;
  thresholdMinor: number;
}

interface LowBalanceSectionProps {
  readonly initialConfig: LowBalanceDraft;
  /** Presence of a card, not `mandateActive` (design "`cardAvailable` wiring"). */
  readonly cardAvailable: boolean;
  /** "Visa •••• 4242" for the picker's usage-moment consent note, or `null` with no card. */
  readonly cardLabel: string | null;
  /** Whether the card ALREADY has an active off-session mandate. */
  readonly mandateActive: boolean;
  /**
   * FIX ROUND (review CRITICAL) — fired with the just-persisted config right after a successful
   * Save. `BillingSettingsSections` lifts this into its own `savedConfig` state so the remove
   * dialog's mode-consequence copy tracks an IN-SESSION Save instead of the stale page-load
   * `wallet.lowBalanceMode` prop. Optional only so standalone renders (tests) need not wire it.
   */
  readonly onSaved?: (config: LowBalanceDraft) => void;
}

const SAVE_FAILURE_MESSAGE = "We couldn't save that — please try again.";
const SAVE_SUCCESS_MESSAGE = 'Low-balance settings updated.';

/**
 * BAL-524 — the server refused a card-backed mode because the wallet holds no card. Reachable two
 * ways, and the second is the one the copy is written for: a hand-rolled POST (the picker disables
 * these options without a card), and — the ordinary, blameless case — a SECOND TAB that removed the
 * card since this page loaded. So the copy states the requirement and names the control that meets
 * it, one section down the same page. It never says "try again": a retry cannot fix this.
 * Title derives the mode name from `MODE_OPTIONS` (never a fourth hand-authored copy of it).
 *
 * FIX ROUND (F3) — THERE IS A THIRD PATH, and it is an ORDINARY SAME-TAB flow, not a hand-rolled
 * POST or a second tab. Saved mode is `notify_only` → the client selects a card-backed mode in
 * the picker but does NOT press Save → scrolls down and removes the card in Payment method →
 * scrolls back up. `key={reconcileNonce}` (`billing-settings-sections.tsx`) only remounts this
 * component when the SAVED mode gets reconciled (`modeReconciled`, computed off the server's
 * `savedConfig.mode`, not this component's dirty draft) — a `notify_only` baseline has nothing to
 * reconcile, so no remount happens: the dirty draft survives, and `cardAvailable` simply flips to
 * `false` on the next render. THIS PATH IS NOW BLOCKED BEFORE IT EVER REACHES THE SERVER — see
 * `cardBackedDraftBlockedMode` below, which disables Save and shows an inline warning naming the
 * same lever as this toast — so the toast text here is now reached only by the other two paths.
 */
const NO_SAVED_CARD_DESCRIPTION =
  'Add a card in the Payment method section below, then save this again.';
const ARM_WARNING_MESSAGE =
  "We couldn't finish setting up automatic charging — your low-balance setting is saved. You can retry anytime from here.";

/**
 * FIX ROUND 3 (N1) — the TRUTHFUL Save-success copy for the one case the generic
 * `SAVE_SUCCESS_MESSAGE` overstates: saving `notify_only` while the card on file STILL carries
 * an active mandate (`savedCard?.mandateActive === true`, threaded down as the `mandateActive`
 * prop). The generic toast reads like "you're all set", which a client could reasonably take to
 * mean off-session charging has stopped — it has not. Only `saveLowBalanceConfigAction` ran
 * (writes `lowBalanceMode` only); nothing on this Save path revokes the mandate or clears the
 * card (that is `removeSavedCardAction`, a DIFFERENT control, deliberately not fired here — see
 * the ticket's "option (b) explicitly NOT the chosen path"). So the copy states exactly what DID
 * change (automatic top-ups) and names the one control that stops the rest (removing the card).
 */
const NOTIFY_ONLY_MANDATE_ACTIVE_TOAST_TITLE = 'Automatic top-ups are off.';
const NOTIFY_ONLY_MANDATE_ACTIVE_TOAST_DESCRIPTION =
  "Your card stays on file, and Balo may still settle consultation time you've used beyond your balance against it. Remove the card in Payment method to stop that too.";

/**
 * FIX ROUND 3 (N1) — the same fact, as a standing inline note rather than a one-time toast, so a
 * client who loads the page already on `notify_only` with a live mandate (never having pressed
 * Save this visit) still sees it. Shown whenever the CURRENT draft selection is `notify_only`
 * AND a card with an active mandate is on file — deliberately reading `draft`, not `baseline`,
 * so it also previews truthfully while the client is mid-edit, before they press Save.
 */
const NOTIFY_ONLY_MANDATE_ACTIVE_NOTE =
  "Your card stays on file. Balo may still settle consultation time you've used beyond your balance against it — removing it in the Payment method section below stops that entirely.";

const ARM_SUCCESS_TOAST: Record<CardBackedLowBalanceMode, string> = {
  auto_topup: 'Auto top-up turned on.',
  keep_going: 'Keep me going turned on.',
};

function sameDraft(a: LowBalanceDraft, b: LowBalanceDraft): boolean {
  return (
    a.mode === b.mode && a.reloadMinor === b.reloadMinor && a.thresholdMinor === b.thresholdMinor
  );
}

/**
 * Resolve a `requires_action` mandate confirmation inline via `stripe.handleNextAction` (3DS),
 * mirroring `PayAction.captureMandate`'s abandoned-challenge rule: an abandoned challenge comes
 * back with NO error but the intent still `requires_action`, which must NOT count as captured —
 * that would tell the client automatic charging is on when it is not. Never throws; an
 * unconfigured key, a null Stripe instance, or a rejected `handleNextAction` all resolve `false`
 * (the warning state), never an unhandled rejection.
 */
async function resolveRequiresAction(clientSecret: string): Promise<boolean> {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return false;
  }
  try {
    const stripe = await getStripe(publishableKey);
    if (stripe === null) {
      return false;
    }
    const { setupIntent, error } = await stripe.handleNextAction({ clientSecret });
    return !error && setupIntent?.status === 'succeeded';
  } catch {
    return false;
  }
}

/**
 * BAL-516 — "When your balance runs low", explicit-Save idiom (design "Save pattern"). Local
 * `draft` seeds from `initialConfig`; `baseline` re-seeds on a successful save; `isDirty` = draft
 * ≠ baseline. On failure the draft is NEVER reverted (design: "do not revert the client's typed
 * values" — the client can retry without re-typing).
 *
 * Save is also the mandate-arm invariant's home (design "Arming the mandate from Save"): nothing
 * else in this codebase prevents a client from persisting a card-backed mode with no active
 * mandate, because settings has no Pay press to capture it opportunistically the way
 * `resolveMandateOutcome` does mid-purchase. So when the OUTGOING selection is card-backed and
 * the card's mandate is not already active (and this component hasn't already armed it locally
 * this session), Save chains `armSavedCardMandateAction` under the SAME "Saving…" state, resolves
 * a `requires_action` 3DS step inline via `stripe.handleNextAction` (mirroring
 * `PayAction.captureMandate`'s abandoned-challenge rule: an abandoned challenge comes back with
 * no error but the intent still `requires_action`, which must NOT count as captured), and on
 * failure/abandonment keeps the just-saved preference and shows a non-blocking inline warning +
 * Retry rather than failing the whole Save.
 *
 * The parent (`BillingSettingsSections`) keys this component on `reconcileNonce` so a card
 * removal that reconciles the mode remounts it re-baselined on `notify_only` — any in-flight
 * dirty edits are deliberately dropped in that case (documented there).
 */
export function LowBalanceSection({
  initialConfig,
  cardAvailable,
  cardLabel,
  mandateActive,
  onSaved,
}: Readonly<LowBalanceSectionProps>): React.JSX.Element {
  const [draft, setDraft] = useState<LowBalanceDraft>(initialConfig);
  const [baseline, setBaseline] = useState<LowBalanceDraft>(initialConfig);
  const [pending, setPending] = useState(false);
  const [armedLocally, setArmedLocally] = useState(false);
  const [armWarning, setArmWarning] = useState(false);

  const errors = autoTopupConfigErrors(draft.mode, draft.reloadMinor, draft.thresholdMinor);
  const hasFieldErrors = errors.reload !== undefined || errors.threshold !== undefined;
  const isDirty = !sameDraft(draft, baseline);
  // FIX ROUND 3 (N1) — see `NOTIFY_ONLY_MANDATE_ACTIVE_NOTE`'s docblock.
  const showNotifyOnlyMandateNote = draft.mode === 'notify_only' && cardAvailable && mandateActive;
  /**
   * FIX ROUND (F3) — the card-backed mode currently drafted while the wallet has no card, or
   * `null` when Save is not blocked for this reason. This is the THIRD reachability path
   * `NO_SAVED_CARD_DESCRIPTION`'s docblock now names: a dirty, unsaved card-backed selection that
   * survives a mid-session card removal because no remount occurred (the saved mode had nothing
   * to reconcile). Narrowed ONCE, in the `mode is CardBackedLowBalanceMode` branch of
   * `isCardBackedLowBalanceMode`, so both the disabled Save button below and the inline warning's
   * `CARD_BACKED_MODE_TITLE` lookup read the SAME computation rather than re-deriving (and
   * potentially disagreeing about) the same condition.
   */
  const cardBackedDraftBlockedMode: CardBackedLowBalanceMode | null =
    isCardBackedLowBalanceMode(draft.mode) && !cardAvailable ? draft.mode : null;

  const handleModeChange = useCallback((mode: LowBalanceMode) => {
    setDraft((d) => ({ ...d, mode }));
  }, []);
  const handleReloadChange = useCallback((minor: number) => {
    setDraft((d) => ({ ...d, reloadMinor: minor }));
  }, []);
  const handleThresholdChange = useCallback((minor: number) => {
    setDraft((d) => ({ ...d, thresholdMinor: minor }));
  }, []);

  /** Attempt the mandate arm once (fresh `clientRequestId`), resolving any 3DS `requires_action`
   * step inline. Never throws — every branch ends in either the captured toast/track or the
   * inline warning. */
  const runArm = useCallback(async (mode: CardBackedLowBalanceMode): Promise<void> => {
    setArmWarning(false);
    const clientRequestId = crypto.randomUUID();
    const result = await armSavedCardMandateAction({ clientRequestId });

    const captured =
      result.ok &&
      (result.outcome === 'captured' ||
        (result.outcome === 'requires_action' &&
          (await resolveRequiresAction(result.clientSecret))));

    if (!captured) {
      setArmWarning(true);
      return;
    }

    setArmedLocally(true);
    toast.success(ARM_SUCCESS_TOAST[mode]);
    track(SETTINGS_EVENTS.BILLING_MANDATE_ARMED, { mode });
  }, []);

  const runSave = useCallback(async (): Promise<void> => {
    setPending(true);
    // FIX ROUND (review IMPORTANT) — every Save re-establishes the warning from THIS attempt.
    // Without this, a warning raised by an earlier failed arm survives a later Save that does not
    // arm at all (e.g. switching to `notify_only`), leaving stale copy on screen with a Retry
    // control that has nothing left to retry against.
    setArmWarning(false);
    try {
      const result = await saveLowBalanceConfigAction({
        lowBalanceMode: draft.mode,
        topupReloadMinor: draft.reloadMinor,
        topupThresholdMinor: draft.thresholdMinor,
      });
      if (!result.ok) {
        // BAL-524 — the ONE refusal a retry cannot fix. Everything else keeps the generic copy.
        // `isCardBackedLowBalanceMode(draft.mode)` is a narrowing guard, not a second policy:
        // the server only ever refuses a card-backed write, so a `no_saved_card` beside a
        // `notify_only` draft is structurally impossible and falls back to the generic copy
        // rather than indexing a Record it cannot key.
        if (result.error === 'no_saved_card' && isCardBackedLowBalanceMode(draft.mode)) {
          toast.error(`${CARD_BACKED_MODE_TITLE[draft.mode]} needs a card on file.`, {
            description: NO_SAVED_CARD_DESCRIPTION,
          });
          return;
        }
        toast.error(SAVE_FAILURE_MESSAGE);
        return;
      }

      setBaseline(draft);
      onSaved?.(draft);
      track(SETTINGS_EVENTS.BILLING_LOW_BALANCE_SAVED, { mode: draft.mode });

      if (isCardBackedLowBalanceMode(draft.mode)) {
        const needsArm = cardAvailable && !mandateActive && !armedLocally;
        if (needsArm) {
          await runArm(draft.mode);
          return;
        }
        toast.success(SAVE_SUCCESS_MESSAGE);
        return;
      }
      // FIX ROUND 3 (N1) — `notify_only` with a still-active mandate is the one case the generic
      // toast would overstate: the card and its mandate are untouched by this Save (see the
      // constant's docblock), so off-session settlement can still fire.
      if (draft.mode === 'notify_only' && mandateActive) {
        toast.success(NOTIFY_ONLY_MANDATE_ACTIVE_TOAST_TITLE, {
          description: NOTIFY_ONLY_MANDATE_ACTIVE_TOAST_DESCRIPTION,
        });
        return;
      }
      toast.success(SAVE_SUCCESS_MESSAGE);
    } catch {
      // FIX ROUND (review MINOR) — a thrown Save (transport failure, action-id mismatch after a
      // deploy) previously produced no toast, no inline error, nothing — the button just
      // re-enabled. Match `PaymentMethodManager`'s removal-failure posture.
      toast.error(SAVE_FAILURE_MESSAGE);
    } finally {
      setPending(false);
    }
  }, [draft, cardAvailable, mandateActive, armedLocally, runArm, onSaved]);

  const handleSaveClick = useCallback(() => {
    runSave().catch(() => undefined);
  }, [runSave]);

  const runRetryArm = useCallback(async (): Promise<void> => {
    if (!isCardBackedLowBalanceMode(baseline.mode)) {
      // FIX ROUND (review IMPORTANT) — unreachable in normal use now that every Save clears
      // `armWarning` up front (a non-card-backed baseline means the warning was already cleared),
      // but a defensive Retry press must still dismiss rather than silently do nothing.
      setArmWarning(false);
      return;
    }
    setPending(true);
    try {
      await runArm(baseline.mode);
    } finally {
      setPending(false);
    }
  }, [baseline.mode, runArm]);

  const handleRetryClick = useCallback(() => {
    runRetryArm().catch(() => undefined);
  }, [runRetryArm]);

  return (
    <div className="border-border bg-card rounded-2xl border p-6 shadow-sm">
      <LowBalanceModePicker
        mode={draft.mode}
        onModeChange={handleModeChange}
        reloadMinor={draft.reloadMinor}
        thresholdMinor={draft.thresholdMinor}
        onReloadChange={handleReloadChange}
        onThresholdChange={handleThresholdChange}
        cardAvailable={cardAvailable}
        errors={errors}
        cardLabel={cardLabel}
      />

      {showNotifyOnlyMandateNote && (
        <div className="border-border bg-muted/30 mt-3 flex items-start gap-2 rounded-xl border p-3 text-left">
          <Info
            className="text-muted-foreground mt-0.5 size-4 shrink-0"
            strokeWidth={2.2}
            aria-hidden="true"
          />
          <p className="text-muted-foreground text-xs leading-relaxed font-medium">
            {NOTIFY_ONLY_MANDATE_ACTIVE_NOTE}
          </p>
        </div>
      )}

      {armWarning && (
        <div className="border-warning/40 bg-warning/10 mt-3 flex items-start gap-2 rounded-xl border p-3 text-left">
          <Info
            className="text-warning mt-0.5 size-4 shrink-0"
            strokeWidth={2.3}
            aria-hidden="true"
          />
          <div className="flex-1">
            <p className="text-foreground text-xs leading-relaxed font-medium">
              {ARM_WARNING_MESSAGE}
            </p>
            <button
              type="button"
              onClick={handleRetryClick}
              disabled={pending}
              className="text-primary mt-1.5 text-xs font-semibold hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/*
       * FIX ROUND (F3) — blocks the impossible submit CLIENT-SIDE (the third reachability path
       * documented on `NO_SAVED_CARD_DESCRIPTION` above): a card-backed draft that survives a
       * mid-session card removal with no remount. Deliberately does NOT reset `draft.mode` back
       * to a non-card-backed value — a silent reset would discard the client's chosen intent,
       * which is worse than a blocked button they can see the reason for.
       */}
      {cardBackedDraftBlockedMode !== null && (
        <div className="border-warning/40 bg-warning/10 mt-3 flex items-start gap-2 rounded-xl border p-3 text-left">
          <Info
            className="text-warning mt-0.5 size-4 shrink-0"
            strokeWidth={2.3}
            aria-hidden="true"
          />
          <p className="text-foreground text-xs leading-relaxed font-medium">
            {CARD_BACKED_MODE_TITLE[cardBackedDraftBlockedMode]} needs a card on file.{' '}
            {NO_SAVED_CARD_DESCRIPTION}
          </p>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          onClick={handleSaveClick}
          disabled={!isDirty || hasFieldErrors || pending || cardBackedDraftBlockedMode !== null}
          // The VISIBLE label stays "Save changes". `billing-email-section.tsx` renders an
          // identical one on this same route, so out of context — a screen reader's button list —
          // the two were indistinguishable. Only the accessible name is disambiguated.
          aria-label="Save low-balance settings"
          className="active:scale-[0.98] motion-reduce:active:scale-100"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save changes'
          )}
        </Button>
      </div>
    </div>
  );
}
