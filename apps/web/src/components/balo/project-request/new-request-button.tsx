'use client';

import { useCallback, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { VariantProps } from 'class-variance-authority';
import { Button, type buttonVariants } from '@/components/ui/button';
import type { ProjectRequestEntryPoint } from '@balo/shared/project-requests';

/**
 * Lazy, `ssr: false` (precedent `hero-search.tsx`): keeps Tiptap and the whole
 * `ProjectRequestPanel` tree out of the host page's bundle until the client first asks for it.
 */
const ProjectRequestPanel = dynamic(
  () => import('@/components/balo/project-request/panel').then((m) => m.ProjectRequestPanel),
  { ssr: false }
);

/** The signed-in context-free mounts; `'home'` has its own sign-in-aware host. */
type NewRequestEntryPoint = Extract<ProjectRequestEntryPoint, 'projects' | 'engagement'>;

interface NewRequestButtonProps {
  label: string;
  entryPoint: NewRequestEntryPoint;
  variant?: VariantProps<typeof buttonVariants>['variant'];
  size?: VariantProps<typeof buttonVariants>['size'];
  className?: string;
  /** Sizes the leading Plus icon; defaults to the button's own `size-4`. */
  iconClassName?: string;
}

/**
 * A signed-in "raise a request" front door — opens the context-free `ProjectRequestPanel`
 * (Match mode, no expert) in place: the `/projects` inbox (`'projects'`) and a completed
 * engagement's "Start your next project" (`'engagement'`). Both routes are signed-in, so no
 * `onAuthRequired`.
 *
 * ⚠ The RSC refresh after a submit waits for the drawer to CLOSE, never runs at submit: on the
 * `/projects` empty state the first request flips `isEmpty`, the refresh swaps `InboxEmptyState`
 * for `ParticipantDash`, and that would unmount this button — and the open drawer with it —
 * before the client ever saw the `done` step.
 */
export function NewRequestButton({
  label,
  entryPoint,
  variant,
  size,
  className,
  iconClassName = 'size-4',
}: Readonly<NewRequestButtonProps>): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Mounted on first open and kept mounted, so the drawer's close animation still plays.
  const [mounted, setMounted] = useState(false);
  const submittedRef = useRef(false);

  const onOpen = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

  const onClose = useCallback(() => {
    setOpen(false);
    if (submittedRef.current) {
      submittedRef.current = false;
      router.refresh();
    }
  }, [router]);

  const onSubmitted = useCallback(() => {
    submittedRef.current = true;
  }, []);

  return (
    <>
      <Button type="button" variant={variant} size={size} className={className} onClick={onOpen}>
        <Plus className={iconClassName} aria-hidden="true" />
        {label}
      </Button>
      {mounted && (
        <ProjectRequestPanel
          open={open}
          onClose={onClose}
          entryPoint={entryPoint}
          onSubmitted={onSubmitted}
        />
      )}
    </>
  );
}
