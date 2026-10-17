import { Info } from 'lucide-react';
import type { HelpBlock } from '@/lib/help/types';
import { HELP_PROSE_CLASS } from './help-prose';
import { HelpScreenshot } from './help-screenshot';

function Block({ block }: Readonly<{ block: HelpBlock }>): React.JSX.Element {
  switch (block.kind) {
    case 'html':
      return (
        // The HTML is sanitised once at generation (`sanitizeHelpHtml`) and the freshness test
        // proves the committed string equals `sanitize(render(docs))`, so no render-time pass.
        <div className={HELP_PROSE_CLASS} dangerouslySetInnerHTML={{ __html: block.html }} />
      );
    case 'callout':
      return (
        <aside className="bg-mist border-line mt-6 flex gap-3 rounded-[14px] border px-[18px] py-4">
          <Info aria-hidden="true" className="text-primary mt-0.5 size-[18px] shrink-0" />
          <div>
            <div className="text-foreground text-[15px] font-semibold">Good to know</div>
            <div
              className="text-foreground/90 [&_a]:text-primary mt-1.5 text-[15px] leading-relaxed [&_a]:underline [&_p]:mt-2 [&_p:first-child]:mt-0"
              dangerouslySetInnerHTML={{ __html: block.html }}
            />
          </div>
        </aside>
      );
    case 'image':
      return <HelpScreenshot image={block.image} />;
  }
}

function blockKey(block: HelpBlock): string {
  return block.kind === 'image' ? `image:${block.image.lightSrc}` : `${block.kind}:${block.html}`;
}

/** Renders a guide's ordered content blocks: prose, callouts and screenshots. */
export function HelpBlocks({
  blocks,
}: Readonly<{ blocks: readonly HelpBlock[] }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block) => (
        <Block key={blockKey(block)} block={block} />
      ))}
    </div>
  );
}
