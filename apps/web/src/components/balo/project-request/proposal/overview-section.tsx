'use client';

import { useCallback, useState } from 'react';
import { cn } from '@/lib/utils';
import { RichTextEditor } from '@/components/balo/rich-text-editor';
import { ComposerSection } from './composer-section';
import { COMPOSER_TARGET } from './proposal-composer-state';
import {
  DraftBadge,
  DraftFailedNote,
  DraftingLabel,
  DraftingSkeleton,
  draftedLabel,
  draftingLabel,
} from './proposal-draft-indicators';

interface OverviewSectionProps {
  overview: string;
  onOverviewChange: (html: string) => void;
  companyName: string;
  /** An AI draft is being written: the skeleton covers the editor until it is focused. */
  drafting?: boolean;
  /** The Overview holds an untouched AI draft: show the badge and Clear. */
  drafted?: boolean;
  /** Drafting failed or timed out: show the quiet line. */
  failed?: boolean;
  clientFirstName?: string;
  onClear?: () => void;
}

/**
 * Overview section: the full-variant rich-text editor. `RichTextEditor` takes no
 * `id`, so the wrapper carries the jump-target id (focusable, flashable).
 *
 * While a draft is being written the editor stays mounted and typeable; the skeleton is an
 * opaque, click-through overlay that gives way as soon as the editor takes focus, so typing
 * can discard the draft rather than race it.
 */
export function OverviewSection({
  overview,
  onOverviewChange,
  companyName,
  drafting = false,
  drafted = false,
  failed = false,
  clientFirstName = 'the client',
  onClear,
}: Readonly<OverviewSectionProps>): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const handleFocus = useCallback((): void => setFocused(true), []);
  const handleClear = useCallback((): void => onClear?.(), [onClear]);
  const prompt = `What you'll do, how you'll approach it, and what ${companyName} can expect.`;
  const showSkeleton = drafting && !focused;

  return (
    <ComposerSection
      id="proposal-section-overview"
      title="Overview"
      help={prompt}
      aside={
        drafted ? (
          <DraftBadge label={draftedLabel(clientFirstName)} onClear={handleClear} />
        ) : undefined
      }
    >
      {failed && <DraftFailedNote />}
      {drafting && focused && (
        <DraftingLabel label={draftingLabel(clientFirstName)} className="mb-3" />
      )}
      <div className="relative">
        <div
          id={COMPOSER_TARGET.overview}
          data-flash=""
          tabIndex={-1}
          onFocus={handleFocus}
          className={cn(
            'rounded-[14px]',
            drafted && 'animate-in fade-in duration-500 motion-reduce:animate-none'
          )}
        >
          <RichTextEditor
            variant="full"
            value={overview}
            onChange={onOverviewChange}
            ariaLabel="Proposal overview"
            placeholder={`Describe the work, your approach, and what ${companyName} can expect.`}
          />
        </div>
        {showSkeleton && (
          <div className="bg-background pointer-events-none absolute inset-0 overflow-hidden rounded-[14px]">
            <DraftingSkeleton variant="overview" label={draftingLabel(clientFirstName)} />
          </div>
        )}
      </div>
    </ComposerSection>
  );
}
