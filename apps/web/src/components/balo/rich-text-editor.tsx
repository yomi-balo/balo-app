'use client';

import dynamic from 'next/dynamic';
import { cn } from '@/lib/utils';
import type { RichTextEditorProps, RichTextViewerProps } from './rich-text/types';

export {
  validateDescription,
  isDescriptionEmpty,
  plainTextLength,
  htmlToPlainText,
  DESCRIPTION_MIN_TEXT,
  DESCRIPTION_MAX_TEXT,
} from './rich-text/plain-text';
export type { RichTextEditorProps, RichTextViewerProps } from './rich-text/types';

/**
 * Skeleton shown while Tiptap is being imported — mirrors the bordered container
 * + sticky 44px toolbar so the layout doesn't shift when the editor mounts.
 */
function EditorSkeleton(): React.JSX.Element {
  return (
    <div className="border-border bg-card overflow-hidden rounded-[11px] border">
      <div className="border-border bg-muted/40 flex h-11 items-center gap-1.5 border-b px-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="bg-muted h-7 w-7 animate-pulse rounded-md" />
        ))}
      </div>
      <div className="space-y-2 p-3.5">
        <div className="bg-muted h-3.5 w-3/4 animate-pulse rounded" />
        <div className="bg-muted h-3.5 w-1/2 animate-pulse rounded" />
      </div>
    </div>
  );
}

/**
 * Locked-format rich-text editor (ADR-1022). Code-split with `ssr:false` so the
 * Tiptap bundle never inflates the public expert-profile page's first load; a
 * toolbar skeleton holds the space during import.
 */
export const RichTextEditor = dynamic<RichTextEditorProps>(
  () => import('./rich-text/rich-text-editor-impl'),
  { ssr: false, loading: () => <EditorSkeleton /> }
);

/** Read-only render of brief HTML for the review step (also code-split). */
export const RichTextViewer = dynamic<RichTextViewerProps>(
  () => import('./rich-text/rich-text-viewer-impl'),
  {
    ssr: false,
    loading: () => <div className={cn('text-muted-foreground h-5 animate-pulse')} />,
  }
);
