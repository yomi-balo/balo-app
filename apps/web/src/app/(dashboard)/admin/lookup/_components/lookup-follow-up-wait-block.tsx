'use client';

import { useId } from 'react';
import { Check, ChevronRight, CircleMinus, Clock, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  FINISHED_NOTE,
  WAIT_LABEL,
  type FollowUpLens,
  type FollowUpStepState,
  type FollowUpStepView,
  type FollowUpWaitState,
  type FollowUpWaitView,
} from '../_lib/follow-ups-view';

/**
 * BAL-666 — one wait on the Lookup Follow-ups tab (design reference `lookup-follow-ups.jsx`
 * `WaitBlock` / `StepRow` / `StepMark`). A flat card: a border, no shadow.
 *
 * Collapsed by default. Closed, the block shows one mark per follow-up and the same facts in
 * words; shape carries the meaning and colour only repeats it, so the marks are `aria-hidden`
 * and the words summary beside them is what assistive tech reads. Only a Failed step is red.
 *
 * No Motion library: the chevron turns with a CSS transition that `motion-reduce` switches off.
 */

const MARK_SHAPE: Readonly<Record<FollowUpStepState, string>> = {
  sent: 'filled-circle',
  due: 'ring',
  not_sent: 'ring-dash',
  failed: 'triangle',
};

export function StepMark({ state }: Readonly<{ state: FollowUpStepState }>): React.JSX.Element {
  if (state === 'failed') {
    return (
      <svg
        width={12}
        height={12}
        viewBox="0 0 12 12"
        aria-hidden="true"
        data-mark={MARK_SHAPE[state]}
      >
        <path d="M6 1.2L11.2 10.6H0.8z" className="fill-destructive" />
      </svg>
    );
  }
  const sent = state === 'sent';
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 12 12"
      aria-hidden="true"
      data-mark={MARK_SHAPE[state]}
    >
      <circle
        cx="6"
        cy="6"
        r="4.6"
        strokeWidth="1.4"
        className={cn(sent ? 'fill-success stroke-success' : 'stroke-muted-foreground fill-none')}
      />
      {state === 'not_sent' && (
        <path
          d="M3.7 6h4.6"
          strokeWidth="1.4"
          strokeLinecap="round"
          className="stroke-muted-foreground"
        />
      )}
    </svg>
  );
}

const STEP_ICON: Readonly<Record<FollowUpStepState, LucideIcon>> = {
  sent: Check,
  due: Clock,
  not_sent: CircleMinus,
  failed: TriangleAlert,
};

const STEP_TONE: Readonly<Record<FollowUpStepState, { icon: string; label: string }>> = {
  sent: { icon: 'bg-success/10 text-success', label: 'text-success' },
  due: { icon: 'bg-muted text-muted-foreground', label: 'text-muted-foreground' },
  not_sent: { icon: 'bg-muted text-muted-foreground', label: 'text-muted-foreground' },
  failed: { icon: 'bg-destructive/10 text-destructive', label: 'text-destructive' },
};

const WAIT_TONE: Readonly<Record<FollowUpWaitState, string>> = {
  waiting: 'border-primary/30 bg-primary/10 text-primary',
  finished: 'border-warning/30 bg-warning/10 text-warning',
  stopped: 'border-transparent bg-muted text-muted-foreground',
};

function StepRow({
  step,
  last,
}: Readonly<{ step: FollowUpStepView; last: boolean }>): React.JSX.Element {
  const Icon = STEP_ICON[step.state];
  const tone = STEP_TONE[step.state];
  return (
    <li
      className={cn(
        'grid grid-cols-[26px_1fr] items-start gap-x-3 gap-y-1 py-[11px] sm:grid-cols-[26px_150px_1fr_auto]',
        !last && 'border-border/60 border-b'
      )}
    >
      <span
        className={cn('flex size-[26px] items-center justify-center rounded-lg', tone.icon)}
        aria-hidden="true"
      >
        <Icon className="size-[13px]" />
      </span>
      <div>
        <p className="text-foreground text-[13px] font-semibold">{step.ordinal} follow-up</p>
        <p className="text-muted-foreground mt-px text-xs">{step.offsetLabel}</p>
      </div>
      <div className="col-start-2 min-w-0 sm:col-start-auto">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-[13px] font-bold', tone.label)}>{step.label}</span>
          {step.channel !== null && (
            <span className="text-muted-foreground text-xs">{step.channel}</span>
          )}
        </div>
        {step.delivery.map((line) => (
          <p key={line.key} className="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">
            {line.text}
          </p>
        ))}
        {step.sentence !== null && (
          <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">
            {step.sentence}
            {step.code !== null && (
              <>
                {' '}
                <span className="text-muted-foreground font-mono text-[11px]">{step.code}</span>
              </>
            )}
          </p>
        )}
        {step.detail !== null && (
          <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{step.detail}</p>
        )}
        {step.held !== null && (
          <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{step.held}</p>
        )}
      </div>
      <span className="text-muted-foreground col-start-2 text-xs tabular-nums sm:col-start-auto sm:whitespace-nowrap">
        {step.whenLabel}
      </span>
    </li>
  );
}

interface WaitBlockProps {
  readonly wait: FollowUpWaitView;
  readonly lens: FollowUpLens;
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function WaitBlock({
  wait,
  lens,
  open,
  onToggle,
}: Readonly<WaitBlockProps>): React.JSX.Element {
  const panelId = useId();
  return (
    <div
      className={cn(
        'border-border rounded-xl border',
        wait.state === 'stopped' ? 'bg-muted/30' : 'bg-card'
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="focus-visible:ring-ring flex min-h-[44px] w-full items-start gap-2.5 rounded-xl px-3.5 py-3 text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'text-muted-foreground mt-[15px] size-[15px] shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2.5">
          <span className="block min-w-0 flex-[1_1_260px]">
            <span className="text-muted-foreground block text-[11px] font-bold tracking-wide uppercase">
              {wait.title}
              {lens === 'entity' ? ' · waiting on' : ''}
            </span>
            <span className="text-foreground mt-[3px] block text-sm font-bold">
              {wait.headline}
            </span>
            <span className="text-muted-foreground mt-[3px] block text-[12.5px] leading-snug">
              {wait.context.join(' · ')}
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1">
                {wait.steps.map((step) => (
                  <StepMark key={step.key} state={step.state} />
                ))}
              </span>
              <span
                className={cn(
                  'text-xs font-semibold tabular-nums',
                  wait.hasFailed ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {wait.summary}
              </span>
            </span>
          </span>
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap',
              WAIT_TONE[wait.state]
            )}
          >
            {WAIT_LABEL[wait.state]}
          </span>
        </span>
      </button>
      {open && (
        <div id={panelId} className="border-border/60 border-t">
          {wait.note !== null && (
            <p className="text-muted-foreground px-3.5 pt-2 text-xs leading-snug">{wait.note}</p>
          )}
          <ul className="px-3.5 pt-0.5 pb-1">
            {wait.steps.map((step, index) => (
              <StepRow key={step.key} step={step} last={index === wait.steps.length - 1} />
            ))}
          </ul>
          {wait.state === 'finished' && (
            <p className="text-muted-foreground border-border/60 bg-warning/10 rounded-b-xl border-t px-3.5 py-2 text-xs leading-snug">
              {FINISHED_NOTE}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
