'use client';

import { RichTextEditor } from '@/components/balo/rich-text-editor';
import { ComposerSection } from './composer-section';
import { COMPOSER_TARGET } from './proposal-composer-state';

interface OverviewSectionProps {
  overview: string;
  onOverviewChange: (html: string) => void;
  companyName: string;
}

/**
 * Overview section: the full-variant rich-text editor. `RichTextEditor` takes no
 * `id`, so the wrapper carries the jump-target id (focusable, flashable).
 */
export function OverviewSection({
  overview,
  onOverviewChange,
  companyName,
}: Readonly<OverviewSectionProps>): React.JSX.Element {
  const prompt = `What you'll do, how you'll approach it, and what ${companyName} can expect.`;
  return (
    <ComposerSection id="proposal-section-overview" title="Overview" help={prompt}>
      <div id={COMPOSER_TARGET.overview} data-flash="" tabIndex={-1} className="rounded-[14px]">
        <RichTextEditor
          variant="full"
          value={overview}
          onChange={onOverviewChange}
          ariaLabel="Proposal overview"
          placeholder={`Describe the work, your approach, and what ${companyName} can expect.`}
        />
      </div>
    </ComposerSection>
  );
}
