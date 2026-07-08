'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, EXPERT_AGENCY_EVENTS } from '@/lib/analytics';
import { resolveExpertAgencyAction } from '@/lib/auth/actions/resolve-expert-agency';
import type { ResolveExpertAgencyResult } from '@/lib/expert-agency/types';
import { linkExpertAgencyAction } from '../_actions/link-expert-agency';
import { useWizard } from './expert-application-context';

interface StepAgencyProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

const RETRYABLE_ERROR =
  "We couldn't finish setting this up just now. Nothing was changed — please try again.";

// ── Shared card chrome (keeps the three outcomes DRY) ─────────────

function AgencyBadge({
  children,
  tone,
}: Readonly<{ children: React.ReactNode; tone: 'primary' | 'success' }>): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-xl font-semibold text-white',
        tone === 'success'
          ? 'from-success bg-gradient-to-br to-emerald-500'
          : 'from-primary bg-gradient-to-br to-violet-600'
      )}
    >
      {children}
    </div>
  );
}

/** A plain-fact info note (earnings routing). Never rendered on the SOLO path. */
function InfoNote({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="border-border bg-primary/5 mx-auto mt-4 max-w-sm rounded-xl border p-3.5 text-left">
      <p className="text-foreground text-[13px] leading-relaxed">{children}</p>
    </div>
  );
}

interface OutcomeCardProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  badge: React.ReactNode;
  heading: string;
  children: React.ReactNode;
  actionError: string | null;
  busy: boolean;
  busyLabel: string;
  reduce: boolean;
  onContinue: () => void;
}

function OutcomeCard({
  headingRef,
  badge,
  heading,
  children,
  actionError,
  busy,
  busyLabel,
  reduce,
  onContinue,
}: Readonly<OutcomeCardProps>): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0.15 : 0.35, ease: 'easeOut' }}
      className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-8 text-center shadow-sm sm:p-10"
    >
      {badge}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-foreground text-2xl font-semibold tracking-tight outline-none"
      >
        {heading}
      </h2>
      <div className="text-muted-foreground mx-auto mt-3.5 max-w-sm text-sm leading-relaxed">
        {children}
      </div>

      {actionError !== null && (
        <div
          role="alert"
          className="border-destructive/25 bg-destructive/5 text-destructive mt-4 rounded-xl border p-3 text-left text-[13px]"
        >
          {actionError}
        </div>
      )}

      <div className="mx-auto mt-6 max-w-xs">
        <Button
          type="button"
          size="lg"
          onClick={onContinue}
          disabled={busy}
          className="from-primary shadow-primary/20 hover:shadow-primary/25 w-full bg-gradient-to-r to-violet-600 text-white shadow-md hover:shadow-lg"
        >
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {busyLabel}
            </span>
          ) : (
            'Continue'
          )}
        </Button>
      </div>
    </motion.div>
  );
}

// ── Step ──────────────────────────────────────────────────────────

export function StepAgency({ headingRef }: Readonly<StepAgencyProps>): React.JSX.Element {
  const { expertProfileId, goNext } = useWizard();
  const reduce = useReducedMotion() ?? false;

  const [result, setResult] = useState<ResolveExpertAgencyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Mounted guard so the belt-and-suspenders busy-reset after `goNext()` never fires
  // setState on an unmounted component. On the normal path goNext advances the wizard
  // and this step unmounts (guard → false, reset skipped); the reset only runs if a
  // future non-advance leaves us mounted, so Continue can't wedge (busy stuck).
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // Resolve the determined outcome on mount. The action already fails open to `solo`;
  // the `.catch` is a defensive belt-and-braces so a rejection still lands somewhere.
  useEffect(() => {
    let active = true;
    resolveExpertAgencyAction()
      .then((resolved) => {
        if (active) setResult(resolved);
      })
      .catch(() => {
        if (active) setResult({ kind: 'solo' });
      });
    return () => {
      active = false;
    };
  }, []);

  // Move focus to the outcome heading once it renders (the wizard's on-enter focus
  // fires while this step is still the loading spinner, so re-focus here).
  useEffect(() => {
    if (result === null) return;
    const timer = setTimeout(
      () => headingRef.current?.focus({ preventScroll: true }),
      reduce ? 0 : 120
    );
    return () => clearTimeout(timer);
  }, [result, headingRef, reduce]);

  const handleContinue = useCallback(async (): Promise<void> => {
    if (!expertProfileId) {
      // Defensive — the profile row exists by index 1 (profile at index 0 created it).
      setActionError(RETRYABLE_ERROR);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = await linkExpertAgencyAction({ expertProfileId });
      if (res.success) {
        if (res.outcome !== 'already_linked') {
          track(EXPERT_AGENCY_EVENTS.RESOLVED, { outcome: res.outcome });
        }
        // Self-advancing: goNext skips the shared validation + save, then advances →
        // this step normally unmounts here. The guarded reset below only runs if it
        // didn't (belt-and-suspenders so Continue never gets stuck disabled).
        await goNext();
        if (activeRef.current) setBusy(false);
      } else {
        setActionError(res.error);
        setBusy(false);
      }
    } catch {
      setActionError(RETRYABLE_ERROR);
      setBusy(false);
    }
  }, [expertProfileId, goNext]);

  const onContinue = useCallback((): void => {
    void handleContinue();
  }, [handleContinue]);

  // ── Loading ─────────────────────────────────────────────────────
  if (result === null) {
    return (
      <div
        aria-live="polite"
        className="border-border bg-card mx-auto flex w-full max-w-md flex-col items-center gap-3.5 rounded-2xl border p-10 shadow-sm"
      >
        <Loader2 className="text-primary h-7 w-7 animate-spin" aria-hidden="true" />
        <p className="text-muted-foreground text-sm">Setting up your expert profile&hellip;</p>
      </div>
    );
  }

  // ── JOIN — determined by email; informational, not a decision ────
  if (result.kind === 'join') {
    const { name, memberCount } = result.agency;
    const colleagues =
      memberCount === 1
        ? '1 colleague is already here'
        : `${memberCount} colleagues are already here`;
    return (
      <OutcomeCard
        headingRef={headingRef}
        badge={<AgencyBadge tone="success">{name.charAt(0).toUpperCase()}</AgencyBadge>}
        heading={`You're joining ${name}`}
        actionError={actionError}
        busy={busy}
        busyLabel="Joining…"
        reduce={reduce}
        onContinue={onContinue}
      >
        <p>
          You signed up with a <strong className="text-foreground">{name}</strong> email, so
          you&apos;ll join their team on Balo — {colleagues}. Next you&apos;ll set up your own
          expert profile.
        </p>
        <InfoNote>
          Earnings from your Balo work go to <strong>{name}</strong>, who handle your payouts.
          You&apos;ll arrange those details with them directly.
        </InfoNote>
        <p className="text-muted-foreground mx-auto mt-4 max-w-xs text-xs leading-relaxed">
          Not part of {name}? Sign up with a personal email to work independently instead.
        </p>
      </OutcomeCard>
    );
  }

  // ── PROVISION — corporate domain, not registered; signer = owner ─
  if (result.kind === 'provision') {
    return (
      <OutcomeCard
        headingRef={headingRef}
        badge={
          <AgencyBadge tone="primary">
            <Sparkles className="h-6 w-6" aria-hidden="true" />
          </AgencyBadge>
        }
        heading="Set up your team on Balo"
        actionError={actionError}
        busy={busy}
        busyLabel="Setting up…"
        reduce={reduce}
        onContinue={onContinue}
      >
        <p>
          You&apos;re the first person from your organisation here. You&apos;ll set up your
          team&apos;s presence on Balo and become its owner — colleagues who sign up with the same
          email domain will join you automatically.
        </p>
        <InfoNote>
          Earnings from your team&apos;s work on Balo are paid to your team, and you decide how
          they&apos;re shared. You can transfer ownership later.
        </InfoNote>
      </OutcomeCard>
    );
  }

  // ── SOLO — independent path. NEVER says "agency" (ADR-1034). ─────
  return (
    <OutcomeCard
      headingRef={headingRef}
      badge={
        <AgencyBadge tone="primary">
          <Sparkles className="h-6 w-6" aria-hidden="true" />
        </AgencyBadge>
      }
      heading="Let's set up your expert profile"
      actionError={actionError}
      busy={busy}
      busyLabel="Setting up…"
      reduce={reduce}
      onContinue={onContinue}
    >
      <p>
        You&apos;ll work on Balo as an independent expert. Next, you&apos;ll build your profile —
        your skills, experience, and rates — so clients can find and book you.
      </p>
    </OutcomeCard>
  );
}
