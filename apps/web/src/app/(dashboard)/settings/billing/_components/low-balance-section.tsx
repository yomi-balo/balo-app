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
   * BAL-523 — whether this wallet already carries consultation time used beyond the balance that
   * MAY STILL BE CHARGED to the card on file even after switching to "Just notify me"
   * (`hasUnsettledOverdraftForWallet` — a negative balance, a live session already past zero, or
   * an ended session whose overdraft settlement is still outstanding; read once per page load,
   * server truth, not draft state).
   *
   * ⚠ FIX ROUND 2 (R2) — it does NOT gate the residual-settlement note/toast any more; it chooses
   * WHICH LEVER that copy names (remove the card, or reach out). See
   * `residualSettlementLever`.
   */
  readonly hasUnsettledOverdraft: boolean;
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
 * ways: a hand-rolled POST (the picker disables these options without a card), and — the
 * ordinary, blameless case — a SECOND TAB that removed the card since this page loaded. Both are
 * TOAST-only: in both, a Save attempt genuinely reached and was refused by the server, so "save
 * this again" is literally what happened and literally what fixes it. So the copy states the
 * requirement and names the control that meets it, one section down the same page. It never says
 * "try again" on its own: a bare retry cannot fix this, adding the card first can.
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
 * `cardBackedDraftBlockedMode` below, which disables Save and shows an INLINE warning with its
 * OWN, distinct copy (`NO_SAVED_CARD_INLINE_DESCRIPTION`) — so this toast text is reached only by
 * the other two paths, where a Save attempt genuinely happened.
 *
 * R2 (external review, BAL-524) — SCOPED TO THE TOAST, deliberately. It used to also render at
 * the inline position below; that was wrong there (see `NO_SAVED_CARD_INLINE_DESCRIPTION`'s
 * docblock for why) and is now fixed by giving that position its own string.
 */
const NO_SAVED_CARD_TOAST_DESCRIPTION =
  'Add a card in the Payment method section below, then save this again.';

/**
 * R2 (external review, BAL-524) — the INLINE sibling of `NO_SAVED_CARD_TOAST_DESCRIPTION`, for the
 * one position that string does not fit: the `cardBackedDraftBlockedMode` warning rendered below,
 * which appears when Save is BLOCKED client-side (the F3 third path above). Nothing has been
 * submitted there — no Save attempt has run — so "save this again" would describe an event that
 * never happened. This copy instead tells the client what unblocks Save in the first place: add
 * the card, then this setting becomes available to save.
 */
const NO_SAVED_CARD_INLINE_DESCRIPTION =
  'Add a card in the Payment method section below to use this setting.';

/**
 * BAL-523, FIX ROUND 1 (F3, security) — the SECOND refusal this Save can hear, and it is not a
 * variant of `no_saved_card` above: the server refused a move OUT of a card-backed mode because a
 * session is live on the wallet (`persistLowBalanceConfig`'s `settlement_outstanding` refusal,
 * the same guard the card CHANGE and REMOVE controls already run). Deliberately NOT the generic
 * `SAVE_FAILURE_MESSAGE`: a retry cannot fix this, so telling the client to try again would be
 * false. Warm and factual — this is a wait, not a dead end; the session ends on its own.
 *
 * ⚠ FIX ROUND 2 (R5) — NEUTRAL WORDING, because the guard (`hasActiveSessionForWallet`) matches
 * THREE states and the old copy was true of only one. It also matches a `pending` session that
 * never connected (no consultation happened, nobody is delivering) and an ENDED session whose
 * `settlement_status` is still `processing` (it is over). "A consultation is still running." and
 * "the expert is paid for the time they're delivering" were false on two of the three.
 */
const SAVE_BLOCKED_LIVE_SESSION_TITLE = "We're still finalising a consultation.";
const SAVE_BLOCKED_LIVE_SESSION_DESCRIPTION =
  "We'll keep your current setting until that's wrapped up. You can switch to Just notify me once it's done.";
const ARM_WARNING_MESSAGE =
  "We couldn't finish setting up automatic charging — your low-balance setting is saved. You can retry anytime from here.";

/**
 * BAL-523 — REPLACES BAL-516's `NOTIFY_ONLY_MANDATE_ACTIVE_*` pair (that reasoning is gone from
 * this file, not sitting below).
 *
 * ⚠⚠ FIX ROUND 2 (R1 + R2) — THIS COPY WAS SHIPPED FALSE AND IS NOW TRUE. The previous round
 * claimed "From here we'll pause instead of charging your card" / "Just notify me means we'll
 * pause rather than charge". **Selecting Just notify me does NOT stop the card being charged.**
 * BAL-523's gate is in the LIVE METER (`applyActiveTick`), and every production Case session is
 * `durationSource: 'presence'` — at meeting end the presence finalizer (`settleFromPresence`)
 * posts every billable minute with no mode check and settles off-session, topping the meter's
 * refusal straight back up. Net charge is unchanged by this setting. That mode-blind finalizer is
 * ALSO what guarantees the expert is paid, so it is not fixed here: tracked as **BAL-535**, which
 * needs an ADR ruling first.
 *
 * ⚠ R2 also REVERSED the round-1 `hasUnsettledOverdraft` RE-GATE. That re-gate assumed FUTURE
 * sessions would be disarmed; they are not. So the truthful trigger is BAL-516's again — a
 * card-backed → `notify_only` save with a live mandate means overruns are still charged, whether
 * or not exposure exists right now. `hasUnsettledOverdraft` survives, but as the choice of WHICH
 * LEVER to name, not as the gate.
 *
 * The shared fact both surfaces state: automatic top-ups are off, AND time used beyond the
 * balance is still settled to the card on file at the end of a consultation.
 */
const RESIDUAL_SETTLEMENT_TOAST_TITLE = 'Just notify me is on.';

/** Post-Save lead — the mode IS saved by the time this toast renders, so it states the state. */
const RESIDUAL_SETTLEMENT_TOAST_FACT =
  'Automatic top-ups are off. Time you use beyond your balance during a consultation is still settled to the card on file when it wraps up.';

/**
 * Standing-note lead. Phrased as what the OPTION does rather than what is already saved, because
 * this note reads off `draft` (not `baseline`) and must be true mid-edit, before Save is pressed.
 */
const RESIDUAL_SETTLEMENT_NOTE_FACT =
  'Just notify me turns off automatic top-ups. Time you use beyond your balance during a consultation is still settled to the card on file when it wraps up.';

/**
 * WHICH LEVER TO NAME — this is what `hasUnsettledOverdraft` now decides (R2), and it is the one
 * job that read is genuinely right for. `detachSavedCard` refuses card removal (409
 * `settlement_outstanding`) while the wallet has a live session or an open receivable, so:
 *
 *  · NO unsettled exposure ⇒ removal is the real lever, and it is named.
 *  · unsettled exposure ⇒ do NOT point at removal (it is the case most likely to be refused, and
 *    `payment-method-manager.tsx` was corrected once already for naming an exit the product
 *    refuses). Name a channel that always exists instead.
 *
 * ⚠ NOT A UNIVERSAL, in either direction, and the previous round's comment wrongly claimed one
 * (R7.1). `hasUnsettledOverdraft`'s arm (0) — `balance_minor < 0` — can fire with no live session
 * and no receivable (the `findSettledMissingLedgerCredit` state), where removal WOULD be allowed;
 * and a funded live session refuses removal while this read is false. The mapping is the best
 * available signal for which lever to LEAD with, not a proof about either one.
 */
const RESIDUAL_SETTLEMENT_LEVER_REMOVE_CARD =
  ' Removing the card in Payment method below stops that.';
const RESIDUAL_SETTLEMENT_LEVER_REACH_OUT =
  " There's consultation time on your account still to settle — email support@balo.expert and we'll square it up with you.";

function residualSettlementLever(hasUnsettledOverdraft: boolean): string {
  return hasUnsettledOverdraft
    ? RESIDUAL_SETTLEMENT_LEVER_REACH_OUT
    : RESIDUAL_SETTLEMENT_LEVER_REMOVE_CARD;
}

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
  hasUnsettledOverdraft,
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
  // ⚠ FIX ROUND 2 (R2) — BACK TO THE THREE PRE-BAL-523 CONJUNCTS. Round 1 added a fourth
  // (`hasUnsettledOverdraft`) on the premise that FUTURE sessions would be disarmed by this save.
  // They are not (see the toast constants' ⚠⚠ note — the presence finalizer is mode-blind), so
  // narrowing to "a client who has exposure right now" under-warned everyone else. Every
  // `notify_only` client with a live mandate on a card still has overruns settled to it.
  // `hasUnsettledOverdraft` still runs — it picks the LEVER, not the gate.
  const showResidualSettlementNote = draft.mode === 'notify_only' && cardAvailable && mandateActive;
  /**
   * FIX ROUND (F3) — the card-backed mode currently drafted while the wallet has no card, or
   * `null` when Save is not blocked for this reason. This is the THIRD reachability path
   * `NO_SAVED_CARD_TOAST_DESCRIPTION`'s docblock now names: a dirty, unsaved card-backed selection that
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
        // TWO refusals a retry cannot fix, from two tickets. Each gets its own copy; only the
        // remaining errors fall through to the generic toast.
        //
        // BAL-524. `isCardBackedLowBalanceMode(draft.mode)` is a narrowing guard, not a second
        // policy: the server only ever refuses a card-backed write, so a `no_saved_card` beside a
        // `notify_only` draft is structurally impossible and falls back to the generic copy
        // rather than indexing a Record it cannot key.
        if (result.error === 'no_saved_card' && isCardBackedLowBalanceMode(draft.mode)) {
          toast.error(`${CARD_BACKED_MODE_TITLE[draft.mode]} needs a card on file.`, {
            description: NO_SAVED_CARD_TOAST_DESCRIPTION,
          });
          return;
        }
        // BAL-523, FIX ROUND 1 (F3) — the live-session disarm refusal. Mutually exclusive with
        // the arm above (that one needs a card-backed draft, this one a `notify_only` one), so
        // the order between them is not a precedence decision.
        if (result.error === 'settlement_outstanding') {
          toast.error(SAVE_BLOCKED_LIVE_SESSION_TITLE, {
            description: SAVE_BLOCKED_LIVE_SESSION_DESCRIPTION,
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
      // ⚠ FIX ROUND 2 (R1 + R2) — the generic "Low-balance settings updated." toast reads like
      // "you're all set", which a client would reasonably take to mean off-session charging has
      // stopped. It has not: overruns still settle to the card on file. Same three conjuncts as
      // the standing note, so the two surfaces cannot disagree.
      if (draft.mode === 'notify_only' && cardAvailable && mandateActive) {
        toast.success(RESIDUAL_SETTLEMENT_TOAST_TITLE, {
          description:
            RESIDUAL_SETTLEMENT_TOAST_FACT + residualSettlementLever(hasUnsettledOverdraft),
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
  }, [draft, cardAvailable, mandateActive, hasUnsettledOverdraft, armedLocally, runArm, onSaved]);

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

      {showResidualSettlementNote && (
        <div className="border-border bg-muted/30 mt-3 flex items-start gap-2 rounded-xl border p-3 text-left">
          <Info
            className="text-muted-foreground mt-0.5 size-4 shrink-0"
            strokeWidth={2.2}
            aria-hidden="true"
          />
          <p className="text-muted-foreground text-xs leading-relaxed font-medium">
            {RESIDUAL_SETTLEMENT_NOTE_FACT + residualSettlementLever(hasUnsettledOverdraft)}
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
       * documented on `NO_SAVED_CARD_TOAST_DESCRIPTION` above): a card-backed draft that survives
       * a mid-session card removal with no remount. Deliberately does NOT reset `draft.mode` back
       * to a non-card-backed value — a silent reset would discard the client's chosen intent,
       * which is worse than a blocked button they can see the reason for.
       *
       * R2 (external review, BAL-524) — renders `NO_SAVED_CARD_INLINE_DESCRIPTION`, NOT the
       * toast's copy: nothing has been saved here, so "save this again" would be false in this
       * position. See that constant's docblock.
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
            {NO_SAVED_CARD_INLINE_DESCRIPTION}
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
