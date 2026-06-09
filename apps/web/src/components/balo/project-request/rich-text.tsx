import 'server-only';

import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { RICH_TEXT_CONTENT_CLASS } from '@/components/balo/rich-text/types';
import { cn } from '@/lib/utils';

interface RichTextProps {
  /** Pre-sanitised brief HTML (sanitised again here as defense-in-depth). */
  html: string;
  /** Body text size — `sm` for the compact Phase-2 panel, `base` for the hero. */
  size?: 'sm' | 'base';
  className?: string;
}

/**
 * Server-only renderer for the (already-sanitised) brief HTML. Re-runs
 * `sanitizeProjectHtml` before injecting (never trust at render — defends a row
 * that bypassed ingest sanitisation), then injects via `dangerouslySetInnerHTML`
 * inside a div carrying `RICH_TEXT_CONTENT_CLASS` (the single source of truth for
 * rich-text formatting — there is no `@tailwindcss/typography` plugin). No client
 * JS, no Tiptap — the brief is fully SSR'd.
 */
export function RichText({
  html,
  size = 'sm',
  className,
}: Readonly<RichTextProps>): React.JSX.Element {
  const safeHtml = sanitizeProjectHtml(html);
  return (
    <div
      className={cn(
        'text-muted-foreground leading-relaxed',
        size === 'base' ? 'text-base' : 'text-sm',
        RICH_TEXT_CONTENT_CLASS,
        className
      )}
      // Pre-sanitised server-side (twice). Safe-by-construction render.
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}
