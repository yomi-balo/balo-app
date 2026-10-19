'use client';

import { useCallback, useState } from 'react';
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
}

/**
 * A signed-in "raise a request" front door — opens the context-free `ProjectRequestPanel`
 * (Match mode, no expert) in place: the `/projects` inbox (`'projects'`) and a completed
 * engagement's "Start your next project" (`'engagement'`). Both routes are signed-in, so no
 * `onAuthRequired`. A successful submit refreshes the RSC payload so the host page reflects the
 * new request behind the drawer.
 */
export function NewRequestButton({
  label,
  entryPoint,
  variant,
  size,
  className,
}: Readonly<NewRequestButtonProps>): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Mounted on first open and kept mounted, so the drawer's close animation still plays.
  const [mounted, setMounted] = useState(false);

  const onOpen = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

  const onClose = useCallback(() => {
    setOpen(false);
  }, []);

  const onSubmitted = useCallback(() => {
    router.refresh();
  }, [router]);

  return (
    <>
      <Button type="button" variant={variant} size={size} className={className} onClick={onOpen}>
        <Plus className="h-4 w-4" aria-hidden="true" />
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
