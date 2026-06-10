'use client';

import { cn } from '@/lib/utils';

interface MessageBubbleHtmlProps {
  /** Ingest-sanitised message HTML (escaped text + p/br only — D4). */
  html: string;
  className?: string;
}

/**
 * Minimal renderer for message-bubble HTML. Deliberately NOT `RichTextViewer`
 * (a Tiptap editor instance per bubble would mount 30 editors for 30
 * messages). Message bodies are SERVER-GENERATED escaped text + `<p>`/`<br>`
 * only — sanitised at ingest (`plainMessageToHtml` → `sanitizeProjectHtml`),
 * so injecting the stored HTML is safe-by-construction. Trust-model precedent:
 * `project-request/rich-text.tsx`.
 */
export function MessageBubbleHtml({
  html,
  className,
}: Readonly<MessageBubbleHtmlProps>): React.JSX.Element {
  return (
    <div
      className={cn('text-sm leading-relaxed break-words [&_p]:my-0 [&_p+p]:mt-2', className)}
      // Sanitised at ingest; bodies contain only escaped text + p/br.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
