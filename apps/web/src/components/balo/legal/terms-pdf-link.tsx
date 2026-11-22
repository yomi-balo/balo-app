'use client';

import type { ReactNode } from 'react';
import type { ProjectTermsPdfSurface } from '@balo/analytics/events';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { projectTermsPdfFileName } from '@/lib/legal/project-terms-versions';

interface TermsPdfLinkProps {
  href: string;
  version: string;
  surface: ProjectTermsPdfSurface;
  /** `download` saves the file; `new_tab` opens it in the browser's PDF viewer. */
  mode: 'download' | 'new_tab';
  className?: string;
  children: ReactNode;
}

/** A link to a frozen Projects MSA PDF that records the click. */
export function TermsPdfLink({
  href,
  version,
  surface,
  mode,
  className,
  children,
}: Readonly<TermsPdfLinkProps>): React.JSX.Element {
  const handleClick = (): void => {
    track(PROJECT_EVENTS.PROJECT_TERMS_PDF_DOWNLOADED, { version, surface });
  };

  if (mode === 'download') {
    return (
      <a
        href={href}
        download={projectTermsPdfFileName(version)}
        onClick={handleClick}
        className={className}
      >
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className={className}
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
