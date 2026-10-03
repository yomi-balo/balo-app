'use client';

import { useCallback, useRef } from 'react';
import { Calendar, Check, Lock, Pause } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import type { WorkInFlight } from '../_types/schedule';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The "carries on as normal" line, built from the expert's real counts. Zero counts are omitted. */
export function carriesOnLine({ upcomingConsultations, activeProjects }: WorkInFlight): string {
  const parts: string[] = [];
  if (upcomingConsultations > 0) {
    parts.push(plural(upcomingConsultations, 'upcoming consultation', 'upcoming consultations'));
  }
  if (activeProjects > 0) {
    parts.push(plural(activeProjects, 'active project', 'active projects'));
  }
  if (parts.length === 0) return 'Your calendar connection keeps syncing.';
  return `Your ${parts.join(' and ')} carry on as normal, and your calendar keeps syncing.`;
}

interface PauseWorkDialogProps {
  open: boolean;
  workInFlight: WorkInFlight;
  /** "Pause new work" — the parent closes the dialog and performs the write. */
  onConfirm: () => void;
  /** Escape, the overlay or "Keep me available" — the parent closes the dialog; nothing is written. */
  onCancel: () => void;
}

/**
 * Confirmation before pausing new work. "Keep me available" is the solid primary (and takes
 * initial focus, as the AlertDialog's cancel action); "Pause new work" is the outline button.
 * Dismissal never waits on a pending write: the parent closes the dialog on either action.
 */
export function PauseWorkDialog({
  open,
  workInFlight,
  onConfirm,
  onCancel,
}: Readonly<PauseWorkDialogProps>): React.JSX.Element {
  // Radix closes the dialog after the confirm click too; this tells that close apart from a
  // genuine dismissal so only the latter reports a cancel.
  const confirmedRef = useRef(false);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (next) return;
      if (confirmedRef.current) {
        confirmedRef.current = false;
        return;
      }
      onCancel();
    },
    [onCancel]
  );

  const handleConfirm = useCallback((): void => {
    confirmedRef.current = true;
    onConfirm();
  }, [onConfirm]);

  const impacts = [
    {
      icon: Calendar,
      iconClass: 'text-muted-foreground',
      text: "Clients won't be able to book consultations with you.",
    },
    {
      icon: Pause,
      iconClass: 'text-muted-foreground',
      text: "Clients can't send you new project briefs. Your profile offers to match them with someone similar instead.",
    },
    { icon: Check, iconClass: 'text-success', text: carriesOnLine(workInFlight) },
    {
      icon: Lock,
      iconClass: 'text-muted-foreground',
      text: 'Your hours and time off are kept, ready for when you turn availability back on.',
    },
  ];

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Pause new work?</AlertDialogTitle>
          <AlertDialogDescription>While you&apos;re paused:</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex flex-col gap-3">
          {impacts.map(({ icon: Icon, iconClass, text }) => (
            <li key={text} className="flex items-start gap-2.5">
              <span className="bg-paused-surface flex size-[26px] shrink-0 items-center justify-center rounded-[7px]">
                <Icon className={`size-[15px] ${iconClass}`} aria-hidden="true" />
              </span>
              <span className="text-foreground pt-[3px] text-[13.5px] leading-normal">{text}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-[12.5px] leading-normal">
          You can turn availability back on any time from Schedule.
        </p>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={handleConfirm}
            className={buttonVariants({ variant: 'outline' })}
          >
            Pause new work
          </AlertDialogAction>
          <AlertDialogCancel className={buttonVariants()}>Keep me available</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
