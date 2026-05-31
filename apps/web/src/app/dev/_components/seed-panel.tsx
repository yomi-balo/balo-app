'use client';

import * as React from 'react';
import { useCallback, useState, useTransition } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import { Loader2, Database, CalendarClock, RotateCcw } from 'lucide-react';

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  regenerateExpertsAction,
  refreshAvailabilityAction,
  fullResetAction,
  type RegenerateSummary,
  type RefreshSummary,
  type ResetSummary,
} from '../_actions/seed';

type AnySummary = RegenerateSummary | RefreshSummary | ResetSummary;

type CardState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'success'; summary: AnySummary };

const ICONS = {
  regenerate: Database,
  availability: CalendarClock,
  reset: RotateCcw,
} as const;

type ActionKey = keyof typeof ICONS;

/** One-line human summary for the toast + success block. */
function summarizeRegenerate(s: RegenerateSummary): string {
  return `${s.expertsGenerated} experts • ${s.skillsGenerated} skills • ${s.languagesGenerated} languages • baseline ${s.baselineAt}`;
}
function summarizeRefresh(s: RefreshSummary): string {
  return `${s.availabilityRulesGenerated} rules • ${s.consultationsSeeded} consults (${s.consultationsCancelled} cancelled) • ${s.cacheRowsWritten} cache rows • ${s.expertsWithEarliest} bookable / ${s.expertsNullEarliest} none`;
}

function SummaryRows({ summary }: Readonly<{ summary: AnySummary }>): React.JSX.Element {
  const entries: [string, string | number][] = [];
  if ('experts' in summary) {
    entries.push(['Experts', summary.experts.expertsGenerated]);
    entries.push(['Skills', summary.experts.skillsGenerated]);
    entries.push(['Rules', summary.availability.availabilityRulesGenerated]);
    entries.push(['Cache rows', summary.availability.cacheRowsWritten]);
    entries.push(['Bookable', summary.availability.expertsWithEarliest]);
    entries.push(['Baseline', summary.experts.baselineAt]);
  } else if ('expertsGenerated' in summary) {
    entries.push(['Experts', summary.expertsGenerated]);
    entries.push(['Skills', summary.skillsGenerated]);
    entries.push(['Languages', summary.languagesGenerated]);
    entries.push(['Industries', summary.industriesGenerated]);
    entries.push(['Seed', summary.seedUsedRng]);
    entries.push(['Baseline', summary.baselineAt]);
  } else {
    entries.push(['Rules', summary.availabilityRulesGenerated]);
    entries.push(['Consultations', summary.consultationsSeeded]);
    entries.push(['Cancelled', summary.consultationsCancelled]);
    entries.push(['Cache rows', summary.cacheRowsWritten]);
    entries.push(['Bookable', summary.expertsWithEarliest]);
    entries.push(['No availability', summary.expertsNullEarliest]);
  }

  return (
    <dl className="border-border bg-muted/40 mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border p-3 text-sm">
      {entries.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-mono tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface SeedCardProps {
  actionKey: ActionKey;
  title: string;
  description: string;
  confirmTitle: string;
  confirmBody: string;
  confirmLabel: string;
  state: CardState;
  isPending: boolean;
  /** Renders the card-specific inputs (count / now). */
  children?: React.ReactNode;
  onConfirm: () => void;
}

function SeedCard({
  actionKey,
  title,
  description,
  confirmTitle,
  confirmBody,
  confirmLabel,
  state,
  isPending,
  children,
  onConfirm,
}: Readonly<SeedCardProps>): React.JSX.Element {
  const Icon = ICONS[actionKey];
  const loading = state.status === 'loading' || isPending;
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      whileHover={reduceMotion ? undefined : { y: -2 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
    >
      <Card className="h-full gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon className="text-muted-foreground size-4" aria-hidden="true" />
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {children}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                disabled={loading}
                className="min-h-11 w-full focus-visible:ring-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Working…
                  </>
                ) : (
                  confirmLabel
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
                <AlertDialogDescription>{confirmBody}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11 w-full sm:w-auto">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive hover:bg-destructive/90 min-h-11 w-full text-white sm:w-auto"
                  onClick={onConfirm}
                >
                  {confirmLabel}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {state.status === 'idle' && <p className="text-muted-foreground text-sm">No run yet.</p>}
          {state.status === 'error' && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
            >
              {state.error}
            </div>
          )}
          {state.status === 'success' && <SummaryRows summary={state.summary} />}
        </CardContent>
      </Card>
    </motion.div>
  );
}

export function SeedPanel(): React.JSX.Element {
  const [isPending, startTransition] = useTransition();

  const [count, setCount] = useState('60');
  const [resetCount, setResetCount] = useState('60');
  const [availabilityNow, setAvailabilityNow] = useState('');
  const [resetNow, setResetNow] = useState('');

  const [regenState, setRegenState] = useState<CardState>({ status: 'idle' });
  const [availState, setAvailState] = useState<CardState>({ status: 'idle' });
  const [resetState, setResetState] = useState<CardState>({ status: 'idle' });

  const parseCount = (value: string): number | undefined => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : undefined;
  };

  const onRegenerate = useCallback(() => {
    setRegenState({ status: 'loading' });
    startTransition(async () => {
      const result = await regenerateExpertsAction({ count: parseCount(count) });
      if (result.success) {
        const line = summarizeRegenerate(result.data);
        setRegenState({ status: 'success', summary: result.data });
        toast.success(`Regenerated ${result.data.expertsGenerated} experts`, { description: line });
      } else {
        setRegenState({ status: 'error', error: result.error });
        toast.error('Regenerate failed', { description: result.error });
      }
    });
  }, [count]);

  const onRefresh = useCallback(() => {
    setAvailState({ status: 'loading' });
    startTransition(async () => {
      const result = await refreshAvailabilityAction({
        now: availabilityNow || undefined,
      });
      if (result.success) {
        const line = summarizeRefresh(result.data);
        setAvailState({ status: 'success', summary: result.data });
        toast.success('Availability refreshed', { description: line });
      } else {
        setAvailState({ status: 'error', error: result.error });
        toast.error('Refresh failed', { description: result.error });
      }
    });
  }, [availabilityNow]);

  const onReset = useCallback(() => {
    setResetState({ status: 'loading' });
    startTransition(async () => {
      const result = await fullResetAction({
        count: parseCount(resetCount),
        now: resetNow || undefined,
      });
      if (result.success) {
        const line = `${result.data.experts.expertsGenerated} experts • ${result.data.availability.cacheRowsWritten} cache rows`;
        setResetState({ status: 'success', summary: result.data });
        toast.success('Full reset complete', { description: line });
      } else {
        setResetState({ status: 'error', error: result.error });
        toast.error('Full reset failed', { description: result.error });
      }
    });
  }, [resetCount, resetNow]);

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Database Seeding</h2>
      <p className="text-muted-foreground text-sm">
        Generate deterministic seed experts and rebuild their availability cache. All operations are
        destructive and scoped to <code className="font-mono">@seed.balo.dev</code> users only.
      </p>

      <div className="grid gap-4 md:grid-cols-3">
        <SeedCard
          actionKey="regenerate"
          title="Regenerate Experts"
          description="Wipe seed experts and insert a fresh deterministic set."
          confirmTitle="Regenerate all seed experts?"
          confirmBody="This permanently deletes every seed expert (and their skills, availability, and consultations), then inserts a new set. Real dev users are untouched."
          confirmLabel="Regenerate"
          state={regenState}
          isPending={isPending}
          onConfirm={onRegenerate}
        >
          <div className="space-y-2">
            <Label htmlFor="seed-count">Expert count</Label>
            <Input
              id="seed-count"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              placeholder="150 for stress test"
              className="font-mono tabular-nums"
            />
            <p className="text-muted-foreground font-mono text-xs">1–500</p>
          </div>
        </SeedCard>

        <SeedCard
          actionKey="availability"
          title="Refresh Availability"
          description="Rebuild rules, consultations, and the availability cache."
          confirmTitle="Refresh seed availability?"
          confirmBody="This permanently deletes seed availability rules, consultations, and cache rows, then regenerates them and re-runs the resolver."
          confirmLabel="Refresh"
          state={availState}
          isPending={isPending}
          onConfirm={onRefresh}
        >
          <div className="space-y-2">
            <Label htmlFor="seed-avail-now">Baseline (optional)</Label>
            <Input
              id="seed-avail-now"
              type="datetime-local"
              value={availabilityNow}
              onChange={(e) => setAvailabilityNow(e.target.value)}
              className="font-mono tabular-nums"
            />
          </div>
        </SeedCard>

        <SeedCard
          actionKey="reset"
          title="Full Reset"
          description="Regenerate experts, then rebuild all availability."
          confirmTitle="Run a full reset?"
          confirmBody="This is the most destructive action: it deletes ALL seed experts and availability, then regenerates everything from scratch. Real dev users are untouched."
          confirmLabel="Reset Everything"
          state={resetState}
          isPending={isPending}
          onConfirm={onReset}
        >
          <div className="space-y-2">
            <Label htmlFor="seed-reset-count">Expert count</Label>
            <Input
              id="seed-reset-count"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={resetCount}
              onChange={(e) => setResetCount(e.target.value)}
              placeholder="60"
              className="font-mono tabular-nums"
            />
            <p className="text-muted-foreground font-mono text-xs">1–500</p>
            <Label htmlFor="seed-reset-now">Baseline (optional)</Label>
            <Input
              id="seed-reset-now"
              type="datetime-local"
              value={resetNow}
              onChange={(e) => setResetNow(e.target.value)}
              className="font-mono tabular-nums"
            />
          </div>
        </SeedCard>
      </div>
    </section>
  );
}
