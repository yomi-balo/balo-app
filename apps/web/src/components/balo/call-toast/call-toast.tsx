'use client';

import { useCallback, useId, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Phone, PhoneMissed, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CALL_NOW_COPY } from '@/lib/call-now/call-now-copy';
import { CALL_TOAST_COPY, formatMissedTime } from '@/lib/call-now/call-toast-copy';
import { UP_NEXT_JOIN } from '@/lib/meetings/up-next-copy';
import { cn } from '@/lib/utils';
import { JoinMeetingButton } from '../meetings/join-meeting-button';
import type { CallToastView, MissedToastView, RingingToastView } from './call-toast-model';
import { useCallBrowserNotification } from './use-call-browser-notification';
import { useCallRingSound } from './use-call-ring-sound';

interface CallToastProps {
  view: CallToastView | null;
  onJoin: (view: RingingToastView) => void;
  onDecline: (view: RingingToastView) => void;
  onDismiss: (view: MissedToastView) => void;
  onCallBack: (view: MissedToastView) => void;
  /** Where focus goes when the viewer's own click closes the toast with focus inside it. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

const MISSED_FALLBACK_TITLE = 'You missed a call';

function missedTitle(view: MissedToastView): string {
  if (view.callerLabel === null) return view.fallbackTitle ?? MISSED_FALLBACK_TITLE;
  return view.count > 1
    ? CALL_TOAST_COPY.missedTitleMany(view.count, view.callerLabel)
    : CALL_TOAST_COPY.missedTitle(view.callerLabel);
}

function missedBody(view: MissedToastView): string | null {
  if (view.callerLabel === null) return view.fallbackBody;
  const time = view.startedAt === null ? '' : formatMissedTime(view.startedAt);
  return time === '' ? CALL_TOAST_COPY.missedBodyNoTime : CALL_TOAST_COPY.missedBody(time);
}

function ringingBody(view: RingingToastView): string {
  const about = view.caseTitle === null ? '' : CALL_TOAST_COPY.incomingAbout(view.caseTitle);
  if (view.lens !== 'client') return about;
  const terms =
    view.rateLine === null
      ? CALL_NOW_COPY.clientTermsNoRate
      : CALL_NOW_COPY.clientTerms(view.rateLine);
  return about === '' ? terms : `${about} ${terms}`;
}

function toastTitle(view: CallToastView): string {
  return view.mode === 'ringing'
    ? CALL_TOAST_COPY.incomingTitle(view.callerLabel)
    : missedTitle(view);
}

/**
 * What the announcer says: the title once a call is missed. A ring is announced by the alertdialog
 * itself (its title and body are its accessible name and description), so the announcer stays
 * silent for it and the ring is heard once.
 */
function announcementFor(view: CallToastView): string {
  return view.mode === 'ringing' ? '' : missedTitle(view);
}

/**
 * The callee's one call surface, anchored under the bell beside the arrival toast. RINGING is
 * persistent: no close button and no timeout, "Not now" is the dismissal and it tells the caller.
 * It becomes MISSED in place and stays until it is dismissed, called back, or its rows are read.
 * Nothing here navigates on its own; every move is a click. There is no in-place choice here: a
 * client's Join answers the call as it is.
 */
export function CallToast({
  view,
  onJoin,
  onDecline,
  onDismiss,
  onCallBack,
  returnFocusRef,
}: Readonly<CallToastProps>): React.JSX.Element {
  const titleId = useId();
  const bodyId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const ring = view?.mode === 'ringing' ? view : null;
  useCallRingSound(ring !== null);
  useCallBrowserNotification(ring);

  const announcement = view === null ? '' : announcementFor(view);

  const keepFocus = useCallback((): void => {
    const root = rootRef.current;
    if (root?.contains(document.activeElement)) returnFocusRef?.current?.focus();
  }, [returnFocusRef]);
  const decline = useCallback(
    (ring: RingingToastView): void => {
      keepFocus();
      onDecline(ring);
    },
    [keepFocus, onDecline]
  );
  const dismiss = useCallback(
    (missedView: MissedToastView): void => {
      keepFocus();
      onDismiss(missedView);
    },
    [keepFocus, onDismiss]
  );
  const callBack = useCallback(
    (missedView: MissedToastView): void => {
      keepFocus();
      onCallBack(missedView);
    },
    [keepFocus, onCallBack]
  );

  return (
    <div
      ref={rootRef}
      className="absolute top-[calc(100%+0.5rem)] right-0 z-50 w-[360px] max-w-[calc(100vw-2rem)] max-sm:fixed max-sm:inset-x-4 max-sm:top-16 max-sm:w-auto max-sm:max-w-none"
    >
      <div
        data-slot="call-toast-announcer"
        aria-live={ring === null ? 'polite' : 'assertive'}
        className="sr-only"
      >
        {announcement}
      </div>
      {view !== null && (
        <motion.div
          data-slot="call-toast"
          data-mode={view.mode}
          data-animated={shouldReduceMotion ? 'false' : 'true'}
          role={view.mode === 'missed' ? 'status' : 'alertdialog'}
          aria-label={view.mode === 'missed' ? toastTitle(view) : undefined}
          aria-labelledby={view.mode === 'ringing' ? titleId : undefined}
          aria-describedby={
            view.mode === 'ringing' && ringingBody(view) !== '' ? bodyId : undefined
          }
          initial={shouldReduceMotion ? false : { opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
          className="bg-popover border-border relative rounded-2xl border p-3.5 shadow-lg"
        >
          {view.mode === 'missed' ? (
            <MissedBody view={view} onDismiss={dismiss} onCallBack={callBack} />
          ) : (
            <RingingBody
              view={view}
              titleId={titleId}
              bodyId={bodyId}
              onJoin={onJoin}
              onDecline={decline}
            />
          )}
        </motion.div>
      )}
    </div>
  );
}

function Tile({
  missed,
  children,
}: Readonly<{ missed: boolean; children: React.ReactNode }>): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-xl',
        missed ? 'bg-warning/10 text-warning-strong' : 'bg-primary/10 text-primary'
      )}
    >
      {children}
    </span>
  );
}

function RingingBody({
  view,
  titleId,
  bodyId,
  onJoin,
  onDecline,
}: Readonly<{
  view: RingingToastView;
  titleId: string;
  bodyId: string;
  onJoin: CallToastProps['onJoin'];
  onDecline: CallToastProps['onDecline'];
}>): React.JSX.Element {
  const body = ringingBody(view);
  return (
    <div className="flex items-start gap-3">
      <Tile missed={false}>
        <Phone className="size-[17px]" aria-hidden="true" />
      </Tile>
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-sm leading-snug font-semibold">
          {CALL_TOAST_COPY.incomingTitle(view.callerLabel)}
        </p>
        {body !== '' && (
          <p id={bodyId} className="text-muted-foreground mt-1 text-[13px] leading-snug">
            {body}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <JoinMeetingButton
            ringing
            size="sm"
            joinUrl={view.joinPath}
            ariaLabel={CALL_TOAST_COPY.joinAriaLabel(view.callerLabel)}
            onJoin={() => onJoin(view)}
          >
            {UP_NEXT_JOIN}
          </JoinMeetingButton>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => onDecline(view)}
          >
            {CALL_NOW_COPY.notNow}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MissedBody({
  view,
  onDismiss,
  onCallBack,
}: Readonly<{
  view: MissedToastView;
  onDismiss: CallToastProps['onDismiss'];
  onCallBack: CallToastProps['onCallBack'];
}>): React.JSX.Element {
  const body = missedBody(view);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-1.5 right-1.5 size-11 md:size-8"
        aria-label={CALL_TOAST_COPY.dismiss}
        onClick={() => onDismiss(view)}
      >
        <X className="size-3.5" />
      </Button>
      <div className="flex items-start gap-3">
        <Tile missed>
          <PhoneMissed className="size-[17px]" aria-hidden="true" />
        </Tile>
        <div className="min-w-0 flex-1 pr-10 md:pr-6">
          <p className="text-sm leading-snug font-semibold">{missedTitle(view)}</p>
          {body !== null && (
            <p className="text-muted-foreground mt-1 text-[13px] leading-snug">{body}</p>
          )}
          {view.engagementId !== null && (
            <div className="mt-3">
              <Button type="button" variant="outline" size="sm" onClick={() => onCallBack(view)}>
                <Phone className="size-3.5" aria-hidden="true" />
                {CALL_TOAST_COPY.callBack}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
