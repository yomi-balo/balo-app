'use client';

import * as React from 'react';
import { useCallback, useMemo, useState, useTransition } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import { GitBranch, Loader2, MessageSquareText, Search } from 'lucide-react';

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { BALO_CLOSE_REASONS, type BaloCloseReason } from '@balo/shared/project-requests';
import {
  searchExpertsForInviteAction,
  type ExpertInviteOption,
} from '@/app/(dashboard)/projects/[requestId]/_actions/search-experts-for-invite';
import {
  fastForwardRequestAction,
  inspectFastForwardRequestAction,
  markThreadReadAsPartyAction,
  type FastForwardRequestResult,
  type FastForwardStepReport,
  type FastForwardTrack,
  type InspectFastForwardRequestResult,
  type MarkThreadReadAsPartyResult,
} from '../_actions/fast-forward';
import {
  reachableTargets,
  planFastForward,
  refusalCopy,
  FAST_FORWARD_TARGETS,
  type FastForwardTarget,
  type PlanRefusal,
} from '../_lib/fast-forward-plan';

/**
 * BAL-275 §11 — the dev fast-forward panel. Mirrors `SeedPanel` exactly (`useTransition` +
 * `useCallback`, a `CardState` discriminated union per card, plain shadcn Card primitives,
 * `motion.div` hover lift guarded by `useReducedMotion`, Sonner toast on every user-initiated
 * mutation). It is a dev tool — match SeedPanel's density, do not over-design.
 *
 * ⚠ CLIENT COMPONENT: this file must NEVER import `@/lib/logging` (Pino → `async_hooks`). It
 * needs no `Sentry.captureException` either — every Server Action here returns a typed result
 * rather than throwing.
 */

type LoadedRequest = Extract<InspectFastForwardRequestResult, { success: true }>;
type FastForwardSuccess = Extract<FastForwardRequestResult, { success: true }>;
type MarkReadSuccess = Extract<MarkThreadReadAsPartyResult, { success: true }>;

/** Which track the spine steps act on: one already on the request, or one this run creates. */
type TrackChoice = 'existing' | 'new';

type MutationState<TSuccess> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'success'; data: TSuccess };

const STEP_LABELS: Readonly<Record<FastForwardStepReport['step'], string>> = {
  invite: 'invite',
  eoi: 'eoi',
  request_proposal: 'request_proposal',
  submit_proposal: 'submit_proposal',
  accept: 'accept',
  close: 'close',
  decline_track: 'decline_track',
};

function StepList({
  steps,
}: Readonly<{ steps: readonly FastForwardStepReport[] }>): React.JSX.Element {
  return (
    <ol className="border-border bg-muted/40 mt-3 flex flex-wrap gap-x-1 gap-y-1 rounded-md border p-3 text-sm">
      {steps.map((report, index) => (
        <li key={report.step} className="font-mono">
          {STEP_LABELS[report.step]} {report.success ? '✓' : '✗'}
          {report.actorLabel !== undefined ? ` (as ${report.actorLabel})` : ''}
          {index < steps.length - 1 ? <span className="text-muted-foreground"> · </span> : null}
        </li>
      ))}
    </ol>
  );
}

interface LoadRequestRowProps {
  requestIdInput: string;
  onRequestIdChange: (value: string) => void;
  onInspect: () => void;
  state: MutationState<LoadedRequest>;
  isPending: boolean;
}

function LoadRequestRow({
  requestIdInput,
  onRequestIdChange,
  onInspect,
  state,
  isPending,
}: Readonly<LoadRequestRowProps>): React.JSX.Element {
  const loading = state.status === 'loading' || isPending;
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="text-muted-foreground size-4" aria-hidden="true" />
          Load a request
        </CardTitle>
        <CardDescription>Paste a project request id to begin.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="ff-request-id">Project request id</Label>
            <Input
              id="ff-request-id"
              value={requestIdInput}
              onChange={(e) => onRequestIdChange(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="font-mono"
            />
          </div>
          <Button
            onClick={onInspect}
            disabled={loading || requestIdInput.trim().length === 0}
            className="min-h-11 focus-visible:ring-2"
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Loading…
              </>
            ) : (
              'Inspect'
            )}
          </Button>
        </div>

        {state.status === 'error' && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
          >
            {state.error}
          </div>
        )}
        {state.status === 'success' && (
          <dl className="border-border bg-muted/40 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-mono">{state.data.status}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Client contact</dt>
              <dd>{state.data.clientContactName}</dd>
            </div>
            <div className="col-span-2 flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Tracks</dt>
              <dd className="font-mono">
                {state.data.tracks.length === 0
                  ? 'none'
                  : state.data.tracks.map((t) => `${t.expertName} (${t.status})`).join(', ')}
              </dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

interface FastForwardCardProps {
  loaded: LoadedRequest | null;
  state: MutationState<FastForwardSuccess>;
  isPending: boolean;
  onConfirm: (params: {
    target: FastForwardTarget;
    expertProfileId?: string;
    relationshipId?: string;
    closeReason?: BaloCloseReason;
  }) => void;
}

function FastForwardCard({
  loaded,
  state,
  isPending,
  onConfirm,
}: Readonly<FastForwardCardProps>): React.JSX.Element {
  const [target, setTarget] = useState<FastForwardTarget | ''>('');
  const [expertQuery, setExpertQuery] = useState('');
  const [expertOptions, setExpertOptions] = useState<ExpertInviteOption[]>([]);
  const [expertSearchPending, setExpertSearchPending] = useState(false);
  const [expertProfileId, setExpertProfileId] = useState('');
  const [relationshipId, setRelationshipId] = useState('');
  const [closeReason, setCloseReason] = useState<BaloCloseReason>('unfilled');
  const reduceMotion = useReducedMotion();

  // U7 — "no LIVE track" (plan §11), not raw `tracks.length`: a request whose only track is
  // `declined` should still offer the expert-invite picker, not an unusable declined-only track
  // picker. It is also the OPTION list for the track picker below (fix round): the planner refuses
  // a declined track outright, so offering one could only ever produce a refusal.
  const liveTracks = useMemo(
    () => (loaded === null ? [] : loaded.tracks.filter((t) => t.status !== 'declined')),
    [loaded]
  );

  /**
   * F1(b) — an EXPLICIT operator choice, never one derived from `liveTracks.length === 0`.
   * `inviteExpertsAction` permits inviting ANOTHER expert while earlier tracks are live
   * (`INVITE_WINDOW_STATUSES`), and that is the only way to build a two-proposal comparison
   * fixture; deriving the picker from "there are no tracks yet" made a second invite unreachable.
   * With zero live tracks there is nothing to pick, so the choice collapses to `new` on its own.
   */
  const [trackChoice, setTrackChoice] = useState<TrackChoice>('existing');
  const effectiveTrackChoice: TrackChoice = liveTracks.length === 0 ? 'new' : trackChoice;

  /**
   * F1 — the SELECTED track's status, the grain every spine step actually runs at.
   * `loaded.status` is a max-progress rollup over every live track, so planning from it alone
   * makes a lagging track unreachable and silently drops steps it still needs. `undefined` while
   * no track is picked (or when inviting a new expert): the planner then falls back to request
   * grain, which is correct for the pre-invite path and for the invite window.
   */
  const selectedTrackStatus =
    effectiveTrackChoice === 'existing'
      ? liveTracks.find((track) => track.relationshipId === relationshipId)?.status
      : undefined;

  const targets = useMemo(
    () =>
      loaded === null
        ? []
        : reachableTargets(loaded.status, liveTracks.length > 0, selectedTrackStatus),
    [loaded, liveTracks, selectedTrackStatus]
  );
  // U4/R4 — when the target Select would otherwise be empty, surface WHY instead of an
  // unexplained empty picker. The reason is whichever refusal the first refusing target gives —
  // `request_closed` on a closed request, `track_declined` on a declined track, and so on — never
  // a single hardcoded probe target, which can itself come back `ok` and leave the picker mute.
  const blockingRefusal = useMemo<PlanRefusal | undefined>(() => {
    if (loaded === null || targets.length > 0) return undefined;
    for (const candidate of FAST_FORWARD_TARGETS) {
      const result = planFastForward(loaded.status, candidate, selectedTrackStatus);
      if (!result.ok) return result.refusal;
    }
    return undefined;
  }, [loaded, targets, selectedTrackStatus]);
  const needsExpertPicker = loaded !== null && effectiveTrackChoice === 'new';
  const needsTrackPicker =
    loaded !== null && effectiveTrackChoice === 'existing' && target !== 'closed';
  const loading = state.status === 'loading' || isPending;
  // U8 — the steps this target will run, previewed in the confirm dialog (computed client-side,
  // for free, by the same pure planner that drives `targets` above).
  const previewSteps = useMemo(() => {
    if (loaded === null || target === '') return [];
    const result = planFastForward(loaded.status, target, selectedTrackStatus);
    return result.ok ? result.steps : [];
  }, [loaded, target, selectedTrackStatus]);

  const onSearchExperts = useCallback(() => {
    setExpertSearchPending(true);
    searchExpertsForInviteAction({ q: expertQuery })
      .then((result) => {
        if (result.success) {
          setExpertOptions(result.experts);
        } else {
          toast.error('Expert search failed', { description: result.error });
        }
      })
      .finally(() => setExpertSearchPending(false));
  }, [expertQuery]);

  const handleConfirm = useCallback(() => {
    if (loaded === null || target === '') return;
    // Exactly one of the two ids travels, chosen by the same flag that chose the picker — sending
    // a stale `relationshipId` alongside an invite would make the server plan at TRACK grain and
    // refuse the very invite the operator asked for.
    onConfirm({
      target,
      expertProfileId: effectiveTrackChoice === 'new' ? expertProfileId || undefined : undefined,
      relationshipId: effectiveTrackChoice === 'existing' ? relationshipId || undefined : undefined,
      closeReason: target === 'closed' ? closeReason : undefined,
    });
  }, [
    loaded,
    target,
    effectiveTrackChoice,
    expertProfileId,
    relationshipId,
    closeReason,
    onConfirm,
  ]);

  return (
    <motion.div
      whileHover={reduceMotion ? undefined : { y: -2 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
    >
      <Card className="h-full gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="text-muted-foreground size-4" aria-hidden="true" />
            Fast-forward to a status
          </CardTitle>
          <CardDescription>
            Drives the loaded request forward by invoking the real handler for every step, each with
            the actor that step genuinely requires.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loaded === null && (
            <p className="text-muted-foreground text-sm">
              Load a request above to fast-forward it.
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="ff-target">Target status</Label>
            {loaded !== null && targets.length === 0 && blockingRefusal !== undefined ? (
              <div
                role="alert"
                className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
              >
                {refusalCopy(blockingRefusal)}
              </div>
            ) : (
              <Select
                value={target}
                onValueChange={(value) => setTarget(value as FastForwardTarget)}
                disabled={loaded === null}
              >
                <SelectTrigger id="ff-target" aria-label="Target status" className="w-full">
                  <SelectValue placeholder="Choose a target status" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {(target === 'closed' || target === 'declined_track') && (
            <p className="text-muted-foreground text-xs">
              Runs as Balo staff; this can&apos;t produce a client-withdrawn fixture — withdraw
              through the client UI for that.
            </p>
          )}
          {target === 'accepted' && (
            <p className="text-muted-foreground text-xs">
              Requires the request&apos;s creator to be a non-staff client account; a staff creator
              will refuse here.
            </p>
          )}

          {loaded !== null && liveTracks.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="ff-track-choice">Track to act on</Label>
              <Select
                value={trackChoice}
                onValueChange={(value) => setTrackChoice(value as TrackChoice)}
              >
                <SelectTrigger id="ff-track-choice" aria-label="Track to act on" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="existing">An existing track</SelectItem>
                  <SelectItem value="new">Invite a new expert</SelectItem>
                </SelectContent>
              </Select>
              {effectiveTrackChoice === 'new' && (
                <p className="text-muted-foreground text-xs">
                  Adds a second track to this request — how a two-proposal comparison fixture gets
                  built. Aim at <span className="font-mono">experts_invited</span> to stop at the
                  invite, then pick the new track and drive it on its own.
                </p>
              )}
            </div>
          )}

          {needsExpertPicker && (
            <div className="space-y-2">
              <Label htmlFor="ff-expert-query">Expert to invite</Label>
              <div className="flex gap-2">
                <Input
                  id="ff-expert-query"
                  value={expertQuery}
                  onChange={(e) => setExpertQuery(e.target.value)}
                  placeholder="Search experts"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={onSearchExperts}
                  disabled={expertSearchPending}
                  className="min-h-11 focus-visible:ring-2"
                >
                  {expertSearchPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    'Search'
                  )}
                </Button>
              </div>
              {expertOptions.length > 0 && (
                <Select value={expertProfileId} onValueChange={setExpertProfileId}>
                  <SelectTrigger aria-label="Expert" className="w-full">
                    <SelectValue placeholder="Choose an expert" />
                  </SelectTrigger>
                  <SelectContent>
                    {expertOptions.map((expert) => (
                      <SelectItem key={expert.id} value={expert.id}>
                        {expert.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {needsTrackPicker && (
            <div className="space-y-2">
              <Label htmlFor="ff-track">Track</Label>
              <Select value={relationshipId} onValueChange={setRelationshipId}>
                <SelectTrigger id="ff-track" aria-label="Track" className="w-full">
                  <SelectValue placeholder="Choose a track" />
                </SelectTrigger>
                <SelectContent>
                  {liveTracks.map((track: FastForwardTrack) => (
                    <SelectItem key={track.relationshipId} value={track.relationshipId}>
                      {track.expertName} · {track.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {target === 'closed' && (
            <div className="space-y-2">
              <Label htmlFor="ff-close-reason">Close reason</Label>
              <Select
                value={closeReason}
                onValueChange={(value) => setCloseReason(value as BaloCloseReason)}
              >
                <SelectTrigger id="ff-close-reason" aria-label="Close reason" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BALO_CLOSE_REASONS.map((reason) => (
                    <SelectItem key={reason} value={reason}>
                      {reason}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                disabled={loaded === null || target === '' || loading}
                className="min-h-11 w-full focus-visible:ring-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Working…
                  </>
                ) : (
                  'Fast-forward'
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {target === 'closed' ? 'Close this request?' : 'Fast-forward this request?'}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {target === 'closed'
                    ? `This permanently closes the request, cancels every meeting still scheduled on it (a call already under way keeps running — the cascade only cancels scheduled meetings), and notifies the client — it can't be reopened from here.`
                    : `This runs the real handler for every step between the request's current status and the target you chose, each as the party that step genuinely requires.`}
                </AlertDialogDescription>
                {target !== 'closed' && previewSteps.length > 0 && (
                  <p className="text-muted-foreground font-mono text-xs">
                    Will run: {previewSteps.map((step) => STEP_LABELS[step]).join(' → ')}
                  </p>
                )}
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11 w-full sm:w-auto">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className={
                    target === 'closed'
                      ? 'bg-destructive hover:bg-destructive/90 min-h-11 w-full text-white sm:w-auto'
                      : 'min-h-11 w-full sm:w-auto'
                  }
                  onClick={handleConfirm}
                >
                  {target === 'closed' ? 'Close request' : 'Fast-forward'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {state.status === 'idle' && loaded !== null && (
            <p className="text-muted-foreground text-sm">No run yet.</p>
          )}
          {state.status === 'error' && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
            >
              {state.error}
            </div>
          )}
          {state.status === 'success' && (
            <div className="space-y-1">
              <p className="text-sm">
                {state.data.from} → <span className="font-medium">{state.data.to}</span>
              </p>
              <StepList steps={state.data.steps} />
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

interface MarkReadCardProps {
  loaded: LoadedRequest | null;
  state: MutationState<MarkReadSuccess>;
  isPending: boolean;
  onConfirm: (params: { relationshipId: string; side: 'client' | 'expert' }) => void;
}

function MarkReadCard({
  loaded,
  state,
  isPending,
  onConfirm,
}: Readonly<MarkReadCardProps>): React.JSX.Element {
  const [relationshipId, setRelationshipId] = useState('');
  const [side, setSide] = useState<'client' | 'expert'>('client');
  const reduceMotion = useReducedMotion();
  const loading = state.status === 'loading' || isPending;

  const handleConfirm = useCallback(() => {
    if (relationshipId === '') return;
    onConfirm({ relationshipId, side });
  }, [relationshipId, side, onConfirm]);

  return (
    <motion.div
      whileHover={reduceMotion ? undefined : { y: -2 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
    >
      <Card className="h-full gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquareText className="text-muted-foreground size-4" aria-hidden="true" />
            Mark a thread read
          </CardTitle>
          <CardDescription>
            Advance either party&apos;s read watermark for one track&apos;s thread.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loaded === null && (
            <p className="text-muted-foreground text-sm">
              Load a request above to mark one of its threads read.
            </p>
          )}

          {loaded !== null && loaded.tracks.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="ff-mark-read-track">Track</Label>
              <Select value={relationshipId} onValueChange={setRelationshipId}>
                <SelectTrigger
                  id="ff-mark-read-track"
                  aria-label="Mark-read track"
                  className="w-full"
                >
                  <SelectValue placeholder="Choose a track" />
                </SelectTrigger>
                <SelectContent>
                  {loaded.tracks.map((track) => (
                    <SelectItem key={track.relationshipId} value={track.relationshipId}>
                      {track.expertName} · {track.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="ff-mark-read-side">Side</Label>
            <Select value={side} onValueChange={(value) => setSide(value as 'client' | 'expert')}>
              <SelectTrigger id="ff-mark-read-side" aria-label="Side" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="client">Client</SelectItem>
                <SelectItem value="expert">Expert</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                disabled={loaded === null || relationshipId === '' || loading}
                className="min-h-11 w-full focus-visible:ring-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Working…
                  </>
                ) : (
                  'Mark read'
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Mark this thread read?</AlertDialogTitle>
                <AlertDialogDescription>
                  Advances the chosen party&apos;s read watermark forward for this track&apos;s
                  thread — never backward.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11 w-full sm:w-auto">Cancel</AlertDialogCancel>
                <AlertDialogAction className="min-h-11 w-full sm:w-auto" onClick={handleConfirm}>
                  Mark read
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {state.status === 'idle' && loaded !== null && (
            <p className="text-muted-foreground text-sm">No run yet.</p>
          )}
          {state.status === 'error' && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
            >
              {state.error}
            </div>
          )}
          {state.status === 'success' && (
            <p className="text-muted-foreground font-mono text-sm">{state.data.lastReadAtIso}</p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

export function RequestFastForwardPanel(): React.JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [requestIdInput, setRequestIdInput] = useState('');
  const [inspectState, setInspectState] = useState<MutationState<LoadedRequest>>({
    status: 'idle',
  });
  const [fastForwardState, setFastForwardState] = useState<MutationState<FastForwardSuccess>>({
    status: 'idle',
  });
  const [markReadState, setMarkReadState] = useState<MutationState<MarkReadSuccess>>({
    status: 'idle',
  });

  /**
   * U1 — re-fetch the loaded request's status + tracks. Extracted so a successful mutation can
   * call it too: without this, `loaded.status`/`loaded.tracks` stay frozen after a fast-forward
   * or mark-read, so `reachableTargets` and the pickers keep running off stale data — chaining a
   * second step shows an already-reached target as selectable, then refuses for no visible reason.
   */
  const refreshLoaded = useCallback(async (requestId: string): Promise<void> => {
    const result = await inspectFastForwardRequestAction({ requestId });
    if (result.success) {
      setInspectState({ status: 'success', data: result });
    } else {
      setInspectState({ status: 'error', error: result.error });
    }
  }, []);

  const onInspect = useCallback(() => {
    setInspectState({ status: 'loading' });
    setFastForwardState({ status: 'idle' });
    setMarkReadState({ status: 'idle' });
    startTransition(async () => {
      await refreshLoaded(requestIdInput.trim());
    });
  }, [requestIdInput, refreshLoaded]);

  const onFastForwardConfirm = useCallback(
    (params: {
      target: FastForwardTarget;
      expertProfileId?: string;
      relationshipId?: string;
      closeReason?: BaloCloseReason;
    }) => {
      if (inspectState.status !== 'success') return;
      const requestId = inspectState.data.requestId;
      setFastForwardState({ status: 'loading' });
      startTransition(async () => {
        const result = await fastForwardRequestAction({ requestId, ...params });
        if (result.success) {
          setFastForwardState({ status: 'success', data: result });
          toast.success(`Fast-forwarded to ${result.to}`, {
            description: `${result.from} → ${result.to}`,
          });
          await refreshLoaded(requestId);
        } else {
          setFastForwardState({ status: 'error', error: result.error });
          toast.error('Fast-forward failed', { description: result.error });
        }
      });
    },
    [inspectState, refreshLoaded]
  );

  const onMarkReadConfirm = useCallback(
    (params: { relationshipId: string; side: 'client' | 'expert' }) => {
      if (inspectState.status !== 'success') return;
      const requestId = inspectState.data.requestId;
      setMarkReadState({ status: 'loading' });
      startTransition(async () => {
        const result = await markThreadReadAsPartyAction({ requestId, ...params });
        if (result.success) {
          setMarkReadState({ status: 'success', data: result });
          toast.success('Thread marked read', { description: result.lastReadAtIso });
          await refreshLoaded(requestId);
        } else {
          setMarkReadState({ status: 'error', error: result.error });
          toast.error('Could not mark thread read', { description: result.error });
        }
      });
    },
    [inspectState, refreshLoaded]
  );

  const loaded = inspectState.status === 'success' ? inspectState.data : null;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Project Request Fast-Forward</h2>
      <p className="text-muted-foreground text-sm">
        Drives an already-created project request forward along the real origination spine by
        invoking the real handler for every step, each with the actor that step genuinely requires.{' '}
        <strong className="text-foreground">
          A Full Reset above deletes the seed company&apos;s project requests, so a fast-forwarded
          request does not survive one — make the request by hand first.
        </strong>
      </p>

      <LoadRequestRow
        requestIdInput={requestIdInput}
        onRequestIdChange={setRequestIdInput}
        onInspect={onInspect}
        state={inspectState}
        isPending={isPending}
      />

      {/*
        Fix round — KEYED BY REQUEST ID, deliberately. Both cards hold picker state (target,
        chosen track, chosen expert, close reason) that belongs to ONE request: inspecting a
        DIFFERENT request left a `relationshipId` from the previous one selected, which then
        travelled to the server and refused with "Could not find that track on the request." The
        key changes only when the loaded request changes, so a post-mutation refresh of the SAME
        request (U1) still preserves everything the operator picked.
      */}
      <div className="grid gap-4 md:grid-cols-2">
        <FastForwardCard
          key={`fast-forward-${loaded?.requestId ?? 'no-request'}`}
          loaded={loaded}
          state={fastForwardState}
          isPending={isPending}
          onConfirm={onFastForwardConfirm}
        />
        <MarkReadCard
          key={`mark-read-${loaded?.requestId ?? 'no-request'}`}
          loaded={loaded}
          state={markReadState}
          isPending={isPending}
          onConfirm={onMarkReadConfirm}
        />
      </div>
    </section>
  );
}
