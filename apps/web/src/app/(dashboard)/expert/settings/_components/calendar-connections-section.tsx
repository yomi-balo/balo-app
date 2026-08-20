'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'motion/react';
import { Calendar as CalendarIcon } from 'lucide-react';
import { toast } from 'sonner';
import { IconBadge } from '@/components/balo/icon-badge';
import { SectionError } from '@/components/balo/section/section-states';
import { track, CALENDAR_EVENTS } from '@/lib/analytics';
import { CalendarConnectionsSkeleton } from './calendar-connections-skeleton';
import { CalendarEmptyState } from './calendar-empty-state';
import { CalendarConnectAnother } from './calendar-connect-another';
import { CalendarConnectionCard } from './calendar-connection-card';
import { CalendarO365GuidanceModal } from './calendar-o365-guidance-modal';
import { CalendarAppleNote } from './calendar-apple-note';
import { CalendarTrustRow } from './calendar-trust-row';
import { useCalendarPolling } from '../_hooks/use-calendar-polling';
import { getCalendarConnectionsAction } from '../_actions/get-calendar-connections';
import { initiateCalendarConnectAction } from '../_actions/initiate-calendar-connect';
import { fixCalendarPermissionsAction } from '../_actions/fix-calendar-permissions';
import { disconnectCalendarAction } from '../_actions/disconnect-calendar';
import { toggleConflictCheckAction } from '../_actions/toggle-conflict-check';
import { setTargetCalendarAction } from '../_actions/set-target-calendar';
import {
  PROVIDER_META,
  PROVIDER_ORDER,
  isCalendarProvider,
  isCalendarCredentialStatus,
} from '../_lib/calendar-providers';
import { deriveSlotState, type CalendarTransientState } from '../_lib/calendar-slot-state';
import type { CalendarConnection, CalendarProvider } from '../_types/calendar';

type CalendarSectionState = 'loading' | 'error' | 'ready';
type ConnectSource = 'first_connect' | 'add_another' | 'reconnect' | 'fix_permissions';

const TEN_MINUTES_MS = 10 * 60 * 1000;

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
};

const REDUCED_VARIANTS = {
  hidden: { opacity: 1, y: 0 },
  show: { opacity: 1, y: 0, transition: { duration: 0 } },
};

function sortByProviderOrder(connections: readonly CalendarConnection[]): CalendarConnection[] {
  return [...connections].sort(
    (a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider)
  );
}

/**
 * Merges a polling tick's connections into the existing local state, by provider.
 *
 * ⚠ THE SHAPE, EXPLICITLY (BAL-397 fix round): **`next` is authoritative, EXCEPT for providers
 * in `skipped`.** `useCalendarPolling` filters providers with an in-flight optimistic mutation
 * out of `next` so a concurrent tick cannot clobber them — for those, and only those, `prev`'s
 * row is carried forward. Every OTHER provider absent from `next` is genuinely gone server-side
 * (revoked, or disconnected in another tab) and is DROPPED.
 *
 * The earlier version seeded a Map from `prev` and only ever overwrote from `next`, i.e. a
 * union — so the list could never SHRINK, and a disconnection performed in another tab survived
 * every poll forever. The plan's §6.3 snippet was `next`-shaped and dropped the skip set
 * instead; this is the reconciliation of the two, and it is why `skipped` is a parameter rather
 * than something inferred from the array's contents (an absent provider alone cannot tell you
 * WHY it is absent).
 */
export function mergeConnectionsByProvider(
  prev: readonly CalendarConnection[],
  next: readonly CalendarConnection[],
  skipped: ReadonlySet<CalendarProvider>
): CalendarConnection[] {
  const carriedOver = prev.filter(
    (c) => skipped.has(c.provider) && !next.some((n) => n.provider === c.provider)
  );
  return [...next, ...carriedOver];
}

/**
 * Does this transient state claim a provider CARD?
 *
 * ⚠ `o365_guidance` DOES NOT (BAL-397 fix round). It is a modal — plan §4.3 classifies it as
 * "per provider (state) / SURFACE (render)" and designs neither a body nor a badge for it. When
 * it counted as a slot, clicking **Connect** on the Microsoft card in the empty state flipped
 * `showHero` to `false`, so the hero and BOTH provider cards unmounted and were replaced —
 * behind the modal overlay — by a bodyless Microsoft card and a dashed "Connect Google Calendar"
 * CTA. Cancelling the dialog reinstated the hero. Pure thrash, invisible to a test that only
 * asserts the dialog opened.
 */
export function occupiesSlot(transient: CalendarTransientState | undefined): boolean {
  return transient !== undefined && transient !== 'o365_guidance';
}

/**
 * ONE sub-calendar's `conflictChecking`, set to an explicit value. Both the optimistic write
 * and the revert go through here — they differ only in the value, so writing the nested map
 * out twice was a ~10-line clone of exactly the kind SonarCloud's duplication gate flags, and
 * the sort of place a revert silently drifts from the write it is meant to undo.
 */
function withConflictChecking(
  connections: readonly CalendarConnection[],
  provider: CalendarProvider,
  subCalendarId: string,
  conflictChecking: boolean
): CalendarConnection[] {
  return connections.map((c) =>
    c.provider === provider
      ? {
          ...c,
          subCalendars: c.subCalendars.map((s) =>
            s.id === subCalendarId ? { ...s, conflictChecking } : s
          ),
        }
      : c
  );
}

/** One connection's `targetCalendarId`, set to an explicit value — same write/revert pairing
 *  as `withConflictChecking`. */
function withTargetCalendar(
  connections: readonly CalendarConnection[],
  provider: CalendarProvider,
  targetCalendarId: string | null
): CalendarConnection[] {
  return connections.map((c) => (c.provider === provider ? { ...c, targetCalendarId } : c));
}

/**
 * BAL-397 — replaces `CalendarTab`. Container: owns the fetch, callback-param consumption,
 * transient per-provider state, and every mutation handler. See plan §3–§6 for the full design.
 */
export function CalendarConnectionsSection(): React.JSX.Element {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();

  const [sectionState, setSectionState] = useState<CalendarSectionState>('loading');
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [transient, setTransient] = useState<
    Partial<Record<CalendarProvider, CalendarTransientState>>
  >({});
  const [pendingProviders, setPendingProviders] = useState<ReadonlySet<CalendarProvider>>(
    new Set()
  );

  const pendingProvidersRef = useRef<ReadonlySet<CalendarProvider>>(new Set());
  const consumedCallbackRef = useRef(false);
  /**
   * ⚠ ONE FETCH PER MOUNT (BAL-397 fix round, CRITICAL). `router.replace` below changes the
   * URL, so `useSearchParams()` returns a new instance, so this effect re-runs, falls into the
   * plain-mount branch and fetches AGAIN — and `fetchConnections` opens with
   * `setSectionState('loading')`. The expert coming back from a successful OAuth round trip saw
   * card → skeleton → card on the single most important path in the ticket.
   * `consumedCallbackRef` stopped the *replace* from looping but did nothing about the refetch.
   */
  const didFetchRef = useRef(false);
  const connectTimersRef = useRef<Partial<Record<CalendarProvider, ReturnType<typeof setTimeout>>>>(
    {}
  );
  const pendingMicrosoftSourceRef = useRef<ConnectSource>('first_connect');
  const sectionRef = useRef<HTMLDivElement>(null);

  /**
   * ⚠ A RENDER-PHASE MIRROR OF `connections`, read by the polling callback (BAL-397 fix round,
   * CRITICAL). The `SYNC_PENDING → ACTIVE` edge detection used to live INSIDE the
   * `setConnections` updater, where it fired `toast` and `track(SYNC_PENDING_RESOLVED)`. React
   * state updaters must be pure: `reactStrictMode` defaults to `true`, so React double-invokes
   * every updater in dev, and in production it may re-invoke an updater whose render is
   * discarded — silently DOUBLING the exact metric that tells us whether Apiroc provisioning
   * self-heals. Reading the previous value from this ref lets the edge detection sit outside
   * the updater, where side effects belong.
   */
  const connectionsRef = useRef<readonly CalendarConnection[]>(connections);
  connectionsRef.current = connections;

  // ── Transient + pending-set helpers ──────────────────────────

  const setTransientFor = useCallback(
    (provider: CalendarProvider, value: CalendarTransientState) => {
      setTransient((prev) => ({ ...prev, [provider]: value }));
    },
    []
  );

  const clearTransientFor = useCallback((provider: CalendarProvider) => {
    setTransient((prev) => {
      if (!(provider in prev)) return prev;
      const next = { ...prev };
      delete next[provider];
      return next;
    });
  }, []);

  const markPending = useCallback((provider: CalendarProvider) => {
    const next = new Set(pendingProvidersRef.current);
    next.add(provider);
    pendingProvidersRef.current = next;
    setPendingProviders(next);
  }, []);

  const unmarkPending = useCallback((provider: CalendarProvider) => {
    const next = new Set(pendingProvidersRef.current);
    next.delete(provider);
    pendingProvidersRef.current = next;
    setPendingProviders(next);
  }, []);

  const clearConnectingTimeout = useCallback((provider: CalendarProvider) => {
    const timer = connectTimersRef.current[provider];
    if (timer) {
      clearTimeout(timer);
      delete connectTimersRef.current[provider];
    }
  }, []);

  const armConnectingTimeout = useCallback(
    (provider: CalendarProvider) => {
      clearConnectingTimeout(provider);
      connectTimersRef.current[provider] = setTimeout(() => {
        track(CALENDAR_EVENTS.CONNECTING_TIMEOUT, { provider });
        setTransientFor(provider, 'attempt_failed');
      }, TEN_MINUTES_MS);
    },
    [clearConnectingTimeout, setTransientFor]
  );

  useEffect(
    () => () => {
      for (const timer of Object.values(connectTimersRef.current)) {
        if (timer) clearTimeout(timer);
      }
    },
    []
  );

  // ── Fetch ─────────────────────────────────────────────────────

  /**
   * `silent` skips BOTH surface-state transitions — no skeleton on the way in, no
   * whole-section error on the way out.
   *
   * ⚠ USE IT FOR RECONCILIATION REFETCHES (BAL-397 fix round). A refetch that follows a
   * successful optimistic mutation is confirming what the expert already sees; blanking the
   * Apple note, the trust row and the surviving provider's card back to a skeleton to confirm
   * it undoes the optimism three lines earlier (plan T20 asks for optimism, plan T1 makes
   * `refresh()` reset to `loading` — the two are only reconcilable with this flag). And on
   * failure, the optimistic view is still the better thing to keep on screen than a
   * whole-section error: the mutation itself already succeeded.
   */
  const fetchConnections = useCallback(
    async (options?: { silent?: boolean }): Promise<CalendarConnection[] | null> => {
      const silent = options?.silent === true;
      if (!silent) setSectionState('loading');
      const result = await getCalendarConnectionsAction();
      if (result.ok) {
        const sorted = sortByProviderOrder(result.connections);
        setConnections(sorted);
        setSectionState('ready');
        return sorted;
      }
      if (!silent) setSectionState('error');
      return null;
    },
    []
  );

  const refresh = useCallback(() => {
    void fetchConnections();
  }, [fetchConnections]);

  // ── OAuth mechanics (shared by every entry point) ────────────

  const beginOAuthDirect = useCallback(
    async (provider: CalendarProvider): Promise<void> => {
      setTransientFor(provider, 'connecting');
      armConnectingTimeout(provider);
      const result = await initiateCalendarConnectAction(provider);
      if (result.success && result.connectUrl) {
        globalThis.location.href = result.connectUrl;
      } else {
        clearConnectingTimeout(provider);
        toast.error(result.error ?? 'Failed to initiate calendar connection');
        setTransientFor(provider, 'attempt_failed');
      }
    },
    [armConnectingTimeout, clearConnectingTimeout, setTransientFor]
  );

  /**
   * ⚠ NO `O365_GUIDANCE_CONTINUED` HERE (BAL-397 fix round). This runs from the guidance
   * dialog AND from the `o365_waiting` "Try connecting again" path (T17), which never shows
   * the guidance — so firing it unconditionally emitted a CONTINUED with no preceding SHOWN and
   * forked the funnel (continued > shown). It belongs to `handleGuidanceContinue` alone.
   */
  const handleMicrosoftContinue = useCallback(
    (source: ConnectSource) => {
      track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider: 'microsoft', source });
      void beginOAuthDirect('microsoft');
    },
    [beginOAuthDirect]
  );

  // T5/T6 — hero card / "Connect another calendar".
  const handleConnectEntry = useCallback(
    (provider: CalendarProvider, source: ConnectSource) => {
      if (provider === 'microsoft') {
        track(CALENDAR_EVENTS.O365_GUIDANCE_SHOWN, {});
        pendingMicrosoftSourceRef.current = source;
        setTransientFor('microsoft', 'o365_guidance');
        return;
      }
      track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider: 'google', source });
      void beginOAuthDirect('google');
    },
    [beginOAuthDirect, setTransientFor]
  );

  // T7 — guidance dialog "Continue to Microsoft 365". The ONLY emitter of CONTINUED, so the
  // guidance funnel's two halves always describe the same population.
  const handleGuidanceContinue = useCallback(() => {
    track(CALENDAR_EVENTS.O365_GUIDANCE_CONTINUED, {});
    handleMicrosoftContinue(pendingMicrosoftSourceRef.current);
  }, [handleMicrosoftContinue]);

  // T8 — guidance dismissed (Cancel / Esc / overlay — Dialog's onOpenChange covers all three).
  const handleGuidanceCancel = useCallback(() => {
    track(CALENDAR_EVENTS.O365_GUIDANCE_CANCELLED, {});
    clearTransientFor('microsoft');
  }, [clearTransientFor]);

  // T11/T13/T17 — the card's single retry affordance, branching on what's actually being
  // retried (in-flight connecting vs. a failed attempt vs. o365 admin-approval waiting).
  const handleCardRetryConnect = useCallback(
    (provider: CalendarProvider) => {
      const current = transient[provider];
      if (provider === 'microsoft' && current === 'o365_waiting') {
        track(CALENDAR_EVENTS.O365_WAITING_TRY_AGAIN, {});
        handleMicrosoftContinue('first_connect');
        return;
      }
      if (current === 'attempt_failed') {
        track(CALENDAR_EVENTS.SESSION_EXPIRED_TRY_AGAIN, { provider });
        track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider, source: 'first_connect' });
      } else {
        // T11 "Re-open window" (slot `connecting`) — a re-opened window IS an OAuth round
        // trip and must count as one, or CONNECT_INITIATED under-reports every retry from
        // this arm. `source: 'reopen_window'` keeps it separable from a first attempt.
        track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider, source: 'reopen_window' });
      }
      void beginOAuthDirect(provider);
    },
    [transient, handleMicrosoftContinue, beginOAuthDirect]
  );

  // T12 — connecting "Cancel"; also covers o365_waiting "Not now".
  const handleCancelConnect = useCallback(
    (provider: CalendarProvider) => {
      clearConnectingTimeout(provider);
      clearTransientFor(provider);
    },
    [clearConnectingTimeout, clearTransientFor]
  );

  // T18 — menu "Reconnect". Bypasses guidance entirely, even for Microsoft.
  const handleReconnect = useCallback(
    (provider: CalendarProvider) => {
      track(CALENDAR_EVENTS.RECONNECT_CLICKED, { provider });
      track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider, source: 'reconnect' });
      void beginOAuthDirect(provider);
    },
    [beginOAuthDirect]
  );

  // T19 — "Fix permissions" on the setting_up notice.
  const handleFixPermissions = useCallback(async (provider: CalendarProvider) => {
    track(CALENDAR_EVENTS.FIX_PERMISSIONS_CLICKED, { provider });
    track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider, source: 'fix_permissions' });
    const result = await fixCalendarPermissionsAction(provider);
    if (result.success && result.relinkUrl) {
      globalThis.location.href = result.relinkUrl;
    } else {
      toast.error(result.error ?? 'Failed to generate permission fix link. Please try again.');
    }
  }, []);

  // T20 — menu "Disconnect" → AlertDialog confirmed.
  const handleDisconnect = useCallback(
    async (provider: CalendarProvider) => {
      track(CALENDAR_EVENTS.DISCONNECT_INITIATED, { provider });
      const previous = connections;
      setConnections((prev) => prev.filter((c) => c.provider !== provider));
      markPending(provider);

      const result = await disconnectCalendarAction({ provider });
      unmarkPending(provider);

      if (result.success) {
        // ⚠ THE PROVIDER LABEL ALONE — no trailing "calendar" (BAL-397 fix round). The labels
        // already name the product ("Google Calendar", "Microsoft Outlook"), so appending the
        // word produced "Google Calendar calendar disconnected". Plan §18's "{Provider}
        // calendar …" meant the BRAND, not the display label.
        toast.success(`${PROVIDER_META[provider].label} disconnected`);
        // SILENT — the optimistic removal three lines up is already on screen and the action
        // has already called `revalidatePath`; a loud refetch would replace the whole section
        // (Apple note, trust row, the surviving provider's card) with the skeleton and undo it.
        void fetchConnections({ silent: true });
      } else {
        setConnections(previous);
        toast.error(result.error ?? 'Failed to disconnect calendar');
      }
    },
    [connections, markPending, unmarkPending, fetchConnections]
  );

  // T21 — busy Switch toggled.
  const handleToggleBusy = useCallback(
    async (subCalendarId: string, checked: boolean, provider: CalendarProvider) => {
      const connection = connections.find((c) => c.provider === provider);
      const subCalendar = connection?.subCalendars.find((s) => s.id === subCalendarId);
      const name = subCalendar?.name ?? 'this calendar';
      const previousChecked = subCalendar?.conflictChecking ?? false;

      setConnections((prev) => withConflictChecking(prev, provider, subCalendarId, checked));
      markPending(provider);
      track(CALENDAR_EVENTS.SUB_CALENDAR_TOGGLED, {
        sub_calendar_id: subCalendarId,
        conflict_checking: checked,
        provider,
      });

      const result = await toggleConflictCheckAction({
        subCalendarId,
        conflictChecking: checked,
        provider,
      });

      if (result.success) {
        toast.success(
          checked ? `Blocking time from ${name}` : `No longer blocking time from ${name}`,
          {
            id: `busy-${subCalendarId}`,
          }
        );
      } else {
        // Reverts to the value captured BEFORE the await, never to a hardcoded default.
        setConnections((prev) =>
          withConflictChecking(prev, provider, subCalendarId, previousChecked)
        );
        toast.error(result.error ?? "We couldn't update that calendar.", {
          id: `busy-${subCalendarId}`,
        });
      }
      unmarkPending(provider);
    },
    [connections, markPending, unmarkPending]
  );

  // T22 — book-into Select changed.
  const handleChangeTarget = useCallback(
    async (provider: CalendarProvider, calendarId: string) => {
      const connection = connections.find((c) => c.provider === provider);
      const previousTargetId = connection?.targetCalendarId ?? null;
      const name =
        connection?.subCalendars.find((s) => s.id === calendarId)?.name ?? 'this calendar';

      setConnections((prev) => withTargetCalendar(prev, provider, calendarId));
      markPending(provider);
      track(CALENDAR_EVENTS.TARGET_CALENDAR_SET, { target_calendar_id: calendarId, provider });

      const result = await setTargetCalendarAction({ targetCalendarId: calendarId, provider });

      if (result.success) {
        toast.success(`Bookings will go to ${name}`);
      } else {
        // Reverts to the value captured BEFORE the await, never to a hardcoded default.
        setConnections((prev) => withTargetCalendar(prev, provider, previousTargetId));
        toast.error(result.error ?? "We couldn't update that calendar.");
      }
      unmarkPending(provider);
    },
    [connections, markPending, unmarkPending]
  );

  // ── Mount + OAuth callback params (merged into one effect — BAL-396's race fix) ──

  useEffect(() => {
    let cancelled = false;

    const calendarConnected = searchParams.get('calendar_connected');
    const calendarErrorParam = searchParams.get('calendar_error');
    const calendarStatusParam = searchParams.get('calendar_status');
    const calendarProviderParam = searchParams.get('calendar_provider');
    const provider = isCalendarProvider(calendarProviderParam) ? calendarProviderParam : undefined;
    const status = isCalendarCredentialStatus(calendarStatusParam)
      ? calendarStatusParam
      : undefined;
    const hasCallbackParams = calendarConnected !== null || calendarErrorParam !== null;

    // T14 — `?calendar_connected=true`.
    async function handleConnectedParam(): Promise<void> {
      if (status === 'SYNC_PENDING') {
        toast.warning("Connected — we're still setting up this calendar.");
      } else {
        // ⚠ THE PROVIDER LABEL ALONE — see the note on the disconnect toast.
        toast.success(
          provider ? `${PROVIDER_META[provider].label} connected` : 'Calendar connected'
        );
      }
      if (provider) clearTransientFor(provider);
      await fetchConnections();
    }

    // T15/T16 — `?calendar_error=…`.
    async function handleErrorParam(errorCode: string): Promise<void> {
      if (errorCode === 'o365_admin_approval') {
        // T15 — the array still loads underneath.
        setTransientFor('microsoft', 'o365_waiting');
        await fetchConnections();
        return;
      }

      // T16 — blame the named provider's slot only when it has NO live row; when it does, that
      // row's own state is the truth and the failure is reported by a toast instead. Edge case
      // 4 (`invalid_callback`) names no provider at all and lands on the same toast.
      const fetched = await fetchConnections();
      if (cancelled) return;
      const hasRow = fetched?.some((c) => c.provider === provider) ?? false;
      if (provider && !hasRow) {
        setTransientFor(provider, 'attempt_failed');
        return;
      }
      toast.error("That sign-in didn't finish — nothing changed.");
    }

    async function handleCallbackParams(): Promise<void> {
      if (calendarConnected === 'true') {
        await handleConnectedParam();
        return;
      }
      if (calendarErrorParam) await handleErrorParam(calendarErrorParam);
    }

    async function run(): Promise<void> {
      if (hasCallbackParams) {
        // ⚠ THE ONE-SHOT IS CLAIMED BEFORE THE AWAITS, NOT AFTER (BAL-397 fix round). Claiming
        // it afterwards left a window in which a second effect run — React's StrictMode
        // double-invoke, or any re-render that hands back a fresh `searchParams` — re-entered
        // the whole branch and re-toasted.
        if (consumedCallbackRef.current) return;
        consumedCallbackRef.current = true;
        didFetchRef.current = true;

        await handleCallbackParams();
        if (cancelled) return;

        router.replace(`${pathname}?tab=schedule`, { scroll: false });
        const behavior = reduceMotion ? 'auto' : 'smooth';
        requestAnimationFrame(() => {
          sectionRef.current?.scrollIntoView({ behavior, block: 'start' });
        });
        return;
      }

      // T1 — plain mount / no callback params.
      // ⚠ THE GUARD THAT KILLS THE SKELETON FLASH. `router.replace` above rewrites the URL to
      // `?tab=schedule`, which re-runs this effect with the params gone — landing here. Without
      // the guard that is a SECOND `fetchConnections()`, and its `setSectionState('loading')`
      // tears down the card the expert is already looking at. See `didFetchRef`.
      if (didFetchRef.current) return;
      didFetchRef.current = true;
      await fetchConnections();
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── Polling ───────────────────────────────────────────────────

  const pollEnabled = connections.some((c) => c.credentialStatus === 'SYNC_PENDING');

  const handlePolledConnections = useCallback((next: CalendarConnection[]) => {
    // ⚠ EDGE DETECTION RUNS HERE, OUTSIDE THE UPDATER. `toast` and `track` are side effects,
    // and a state updater must be pure — React double-invokes updaters under StrictMode and may
    // re-invoke one whose render is discarded, which doubled both the toast and the
    // `SYNC_PENDING_RESOLVED` counter. `connectionsRef` carries the pre-tick value that the
    // updater's `prev` used to supply.
    for (const updated of next) {
      const before = connectionsRef.current.find((c) => c.provider === updated.provider);
      if (before?.credentialStatus !== 'SYNC_PENDING') continue;
      if (updated.credentialStatus === 'ACTIVE') {
        toast.success(`${PROVIDER_META[updated.provider].label} is ready`);
        track(CALENDAR_EVENTS.SYNC_PENDING_RESOLVED, { provider: updated.provider });
      } else if (updated.credentialStatus === 'EXPIRED' || updated.credentialStatus === 'REVOKED') {
        toast.error(`We lost access to your ${PROVIDER_META[updated.provider].label}.`);
      }
    }

    // `pendingProvidersRef` is the SAME set the hook just filtered `next` with (it reads this
    // ref, synchronously, immediately before calling back), so the merge can tell "absent
    // because skipped" from "absent because gone".
    const skipped = pendingProvidersRef.current;
    setConnections((prev) => sortByProviderOrder(mergeConnectionsByProvider(prev, next, skipped)));
  }, []);

  useCalendarPolling({
    enabled: pollEnabled,
    skipProviders: () => pendingProvidersRef.current,
    onConnections: handlePolledConnections,
  });

  // ── Which providers render where (§3.3) ──────────────────────

  const connectionByProvider = useMemo(
    () => new Map(connections.map((c) => [c.provider, c] as const)),
    [connections]
  );
  const hasSlot = useCallback(
    (provider: CalendarProvider) =>
      connectionByProvider.has(provider) || occupiesSlot(transient[provider]),
    [connectionByProvider, transient]
  );
  const visibleSlots = PROVIDER_ORDER.filter(hasSlot);
  const offerableProviders = PROVIDER_ORDER.filter((provider) => !hasSlot(provider));
  const showHero = visibleSlots.length === 0;
  const [nextOfferable] = offerableProviders;

  const motionContainer = reduceMotion
    ? { hidden: REDUCED_VARIANTS.hidden, show: REDUCED_VARIANTS.show }
    : containerVariants;
  const motionItem = reduceMotion ? REDUCED_VARIANTS : itemVariants;

  return (
    <div ref={sectionRef}>
      <motion.div variants={motionContainer} initial="hidden" animate="show">
        <motion.div variants={motionItem} className="mb-6 flex items-center gap-3">
          <IconBadge icon={CalendarIcon} color="#7C3AED" size={44} iconSize={22} />
          <div>
            <h2 className="text-foreground text-xl font-semibold">Calendar</h2>
            <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
              Connect a calendar to keep your availability accurate and send confirmed bookings
              straight to your schedule.
            </p>
          </div>
        </motion.div>

        <motion.div variants={motionItem}>
          {sectionState === 'loading' && <CalendarConnectionsSkeleton />}

          {sectionState === 'error' && (
            <SectionError
              label="your calendars"
              body="This is usually temporary. Your calendar connection itself is safe."
              onRetry={refresh}
            />
          )}

          {sectionState === 'ready' && (
            <div className="space-y-4">
              {showHero && (
                <CalendarEmptyState
                  providers={offerableProviders}
                  onConnect={(provider) => handleConnectEntry(provider, 'first_connect')}
                />
              )}

              {/* `showHero` is `visibleSlots.length === 0`, so this map is already empty when
                  the hero shows — no redundant `!showHero &&` guard. */}
              {visibleSlots.map((provider) => (
                <CalendarConnectionCard
                  key={provider}
                  provider={provider}
                  slotState={deriveSlotState({
                    connection: connectionByProvider.get(provider),
                    transient: transient[provider],
                  })}
                  connection={connectionByProvider.get(provider)}
                  // ⚠ PENDING IS TRACKED PER PROVIDER, NOT PER ROW — a DELIBERATE simplification
                  // of plan §6.1, not an oversight. One in-flight toggle therefore disables every
                  // switch on that connection. It is coarser and mildly worse UX, but it is also
                  // exactly the granularity the poll skip set uses (`pendingProvidersRef`), so
                  // splitting them would mean two pending models that must agree. Revisit only
                  // alongside a per-row skip set.
                  pending={pendingProviders.has(provider)}
                  onConnect={handleCardRetryConnect}
                  onCancelConnect={handleCancelConnect}
                  onReconnect={handleReconnect}
                  onFixPermissions={handleFixPermissions}
                  onDisconnect={handleDisconnect}
                  onToggleBusy={handleToggleBusy}
                  onChangeTarget={(calendarId) => handleChangeTarget(provider, calendarId)}
                />
              ))}

              {!showHero && nextOfferable && (
                <CalendarConnectAnother
                  provider={nextOfferable}
                  onConnect={(provider) => handleConnectEntry(provider, 'add_another')}
                />
              )}

              <CalendarAppleNote />
              <CalendarTrustRow />
            </div>
          )}
        </motion.div>
      </motion.div>

      <CalendarO365GuidanceModal
        open={transient.microsoft === 'o365_guidance'}
        onContinue={handleGuidanceContinue}
        onCancel={handleGuidanceCancel}
      />
    </div>
  );
}
