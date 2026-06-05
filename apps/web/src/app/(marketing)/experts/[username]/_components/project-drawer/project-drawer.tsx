'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Briefcase, Check, ChevronLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS, type ProjectStep } from '@/lib/analytics';
import { Drawer, DrawerHeader, DrawerBody, DrawerFooter, FlowStepper } from '@/components/flow';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { submitProjectRequestAction } from '../../_actions/submit-project-request';
import { PROJECT_PATHS, PROJECT_AREAS, BUDGETS, TIMELINES, PROJECT_STEPS } from './constants';
import { FieldLabel } from './field-label';
import { ChipRow } from './chip-row';
import { PathCard } from './path-card';
import { useProjectDraft } from './use-project-draft';

interface ProjectDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expertProfileId: string;
  expertName: string;
  expertFirstName: string;
}

/** Mutable steps for the stepper (the readonly `as const` tuple isn't assignable). */
const STEPPER_STEPS = PROJECT_STEPS.map((s) => ({ key: s.key, label: s.label }));

/**
 * Top-level project-request drawer. State machine: `start → manual → review →
 * done` (the AI path renders as a disabled card only). Built on the shared
 * `Drawer` / `FlowStepper` flow primitives (desktop right panel ↔ mobile bottom
 * sheet, portal, focus trap, Esc, scroll-lock — all free). Autosaves the form to
 * localStorage, fires the four client-side funnel events, and submits via the
 * `submitProjectRequestAction` Server Action.
 */
export function ProjectDrawer({
  open,
  onOpenChange,
  expertProfileId,
  expertName,
  expertFirstName,
}: Readonly<ProjectDrawerProps>): React.JSX.Element {
  const [step, setStep] = useState<ProjectStep>('start');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { draft, setField, clearDraft } = useProjectDraft(expertProfileId);
  const { title, description, focusArea, budget, timeline } = draft;

  const titleId = useId();
  const descriptionId = useId();

  // Land keyboard/AT users in the form when the manual step opens. A ref + effect
  // (not bare `autoFocus`) so it only fires on the manual transition and doesn't
  // misfire on drawer mount or fight the Drawer's own initial focus-trap focus.
  const titleInputRef = useRef<HTMLInputElement>(null);

  const reviewValid = title.trim().length > 0 && description.trim().length > 0;

  // Fire `drawer_opened` once per open (guard against the effect re-running).
  const openFiredRef = useRef(false);
  useEffect(() => {
    if (!open) {
      openFiredRef.current = false;
      return;
    }
    if (openFiredRef.current) return;
    openFiredRef.current = true;
    setStep('start');
    setError(null);
    track(PROJECT_EVENTS.PROJECT_DRAWER_OPENED, { expert_id: expertProfileId });
  }, [open, expertProfileId]);

  // `step_viewed` on every step change while open (start is the impression, the
  // rest are funnel progress).
  useEffect(() => {
    if (!open) return;
    track(PROJECT_EVENTS.PROJECT_STEP_VIEWED, { expert_id: expertProfileId, step });
  }, [open, step, expertProfileId]);

  // Clear any stale submit error once the user leaves the review step (via the
  // stepper "Describe" jump or the Back button) so it doesn't reappear unchanged
  // on return — covers both navigation paths in one place.
  useEffect(() => {
    if (step !== 'review') setError(null);
  }, [step]);

  // Focus the title field when (and only when) the manual step becomes active.
  useEffect(() => {
    if (step === 'manual') titleInputRef.current?.focus();
  }, [step]);

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleSelectManual = useCallback(() => {
    track(PROJECT_EVENTS.PROJECT_ENTRY_SELECTED, { expert_id: expertProfileId, method: 'manual' });
    setStep('manual');
  }, [expertProfileId]);

  const handleJump = useCallback((key: string) => {
    if (key === 'start' || key === 'manual' || key === 'review') setStep(key);
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    const result = await submitProjectRequestAction({
      expertProfileId,
      title: title.trim(),
      description: description.trim(),
      focusArea,
      budget,
      timeline,
      source: 'manual',
    });
    setSubmitting(false);

    if (!result.success) {
      const message = result.error ?? 'Something went wrong. Please try again.';
      setError(message);
      toast.error(message);
      return;
    }

    track(PROJECT_EVENTS.PROJECT_REQUEST_SUBMITTED, {
      expert_id: expertProfileId,
      has_budget: budget !== null,
      has_timeline: timeline !== null,
      focus_areas: focusArea ? [focusArea] : [],
      method: 'manual',
    });
    clearDraft();
    toast.success('Request sent', {
      description: `${expertFirstName} will reply with a proposal.`,
    });
    setStep('done');
  }, [
    expertProfileId,
    expertFirstName,
    title,
    description,
    focusArea,
    budget,
    timeline,
    clearDraft,
  ]);

  const fields = (
    <>
      <div className="space-y-2">
        <FieldLabel htmlFor={titleId}>Project title</FieldLabel>
        <Input
          ref={titleInputRef}
          id={titleId}
          value={title}
          onChange={(e) => setField('title', e.target.value)}
          placeholder="e.g. Rebuild our lead routing in Flow"
        />
      </div>

      <div className="space-y-2">
        <FieldLabel htmlFor={descriptionId}>What do you need?</FieldLabel>
        <Textarea
          id={descriptionId}
          value={description}
          onChange={(e) => setField('description', e.target.value)}
          rows={5}
          placeholder="Describe the problem or the outcome you're after — a rough sketch is fine."
        />
        <p className="text-muted-foreground text-xs leading-relaxed">
          Keep it as short as you like — you can refine it with {expertFirstName} later.
        </p>
      </div>

      <div className="space-y-2">
        <FieldLabel optional>Focus area</FieldLabel>
        <ChipRow
          options={PROJECT_AREAS}
          value={focusArea}
          onChange={(v) => setField('focusArea', v)}
          ariaLabel="Focus area"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <FieldLabel optional>Budget</FieldLabel>
          <ChipRow
            options={BUDGETS}
            value={budget}
            onChange={(v) => setField('budget', v)}
            ariaLabel="Budget"
          />
        </div>
        <div className="space-y-2">
          <FieldLabel optional>Timeline</FieldLabel>
          <ChipRow
            options={TIMELINES}
            value={timeline}
            onChange={(v) => setField('timeline', v)}
            ariaLabel="Timeline"
          />
        </div>
      </div>
    </>
  );

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Start a project"
      widthClassName="sm:max-w-[520px]"
    >
      <div className="flex h-full flex-col">
        <DrawerHeader onClose={handleClose}>
          {step === 'done' ? (
            <h2 className="text-foreground text-base font-semibold">Request sent</h2>
          ) : (
            <FlowStepper steps={STEPPER_STEPS} current={step} onJump={handleJump} />
          )}
        </DrawerHeader>

        <DrawerBody>
          {step === 'start' && (
            <div className="space-y-5 p-6">
              <div className="space-y-2">
                <h2 className="text-foreground text-xl font-semibold tracking-[-0.01em]">
                  Start a project with {expertName}
                </h2>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  Tell us what you need and {expertFirstName} replies with a scoped proposal. Pick
                  how you&apos;d like to begin — it only takes a minute or two.
                </p>
              </div>
              <div className="flex flex-col gap-3">
                {PROJECT_PATHS.map((path) => (
                  <PathCard
                    key={path.key}
                    path={path}
                    onClick={path.key === 'manual' ? handleSelectManual : undefined}
                  />
                ))}
              </div>
            </div>
          )}

          {step === 'manual' && (
            <div className="space-y-5 p-6">
              <button
                type="button"
                onClick={() => setStep('start')}
                className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded-md text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Change entry method
              </button>
              {fields}
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-5 p-6">
              {fields}
              {error && (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === 'done' && (
            <div className="px-8 py-12 text-center">
              <span className="from-primary mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br to-violet-600 text-white shadow-[0_8px_28px_rgba(99,102,241,0.35)] dark:to-violet-500">
                <Check className="h-7 w-7" aria-hidden="true" />
              </span>
              <h2 className="text-foreground text-xl font-semibold">
                Request sent to {expertFirstName}
              </h2>
              <p className="text-muted-foreground mx-auto mt-2.5 max-w-[340px] text-sm leading-relaxed">
                {expertFirstName} will review your brief and reply with a scoped proposal, usually
                within a day. We&apos;ll email you and notify you in-app.
              </p>
            </div>
          )}
        </DrawerBody>

        {step === 'manual' && (
          <DrawerFooter>
            <BackButton onClick={() => setStep('start')} />
            <PrimaryButton onClick={() => setStep('review')} disabled={!reviewValid}>
              Review <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </PrimaryButton>
          </DrawerFooter>
        )}

        {step === 'review' && (
          <DrawerFooter>
            <BackButton onClick={() => setStep('manual')} disabled={submitting} />
            <PrimaryButton onClick={handleSubmit} disabled={!reviewValid || submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Sending…
                </>
              ) : (
                <>
                  <Briefcase className="h-4 w-4" aria-hidden="true" /> Submit request
                </>
              )}
            </PrimaryButton>
          </DrawerFooter>
        )}

        {step === 'done' && (
          <DrawerFooter className="justify-end">
            <PrimaryButton onClick={handleClose}>Done</PrimaryButton>
          </DrawerFooter>
        )}
      </div>
    </Drawer>
  );
}

function BackButton({
  onClick,
  disabled,
}: Readonly<{ onClick: () => void; disabled?: boolean }>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="border-border bg-card text-muted-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-[11px] border px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back
    </button>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: Readonly<{
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'from-primary inline-flex min-h-11 items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r to-violet-600 px-6 text-sm font-semibold text-white shadow-sm transition-all focus-visible:ring-2 focus-visible:ring-violet-500/50 focus-visible:outline-none dark:to-violet-500',
        'enabled:hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none'
      )}
    >
      {children}
    </button>
  );
}
