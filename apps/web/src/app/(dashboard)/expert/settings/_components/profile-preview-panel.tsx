'use client';

import { useState, useCallback, useId } from 'react';
import { Eye, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { ExpertCard } from '@/components/expert';
import type { ExpertCardData } from '@/components/expert';
import { CompletenessBar } from './completeness-bar';
import { SettingsCard, SettingsEyebrow } from './settings-card';

interface ProfilePreviewPanelProps {
  expert: ExpertCardData;
  username: string;
  headline: string;
}

/**
 * Completeness first (the thing to act on), then the "Live preview" section — what clients will
 * see, updated as the expert types: the real `ExpertCard`, the profile URL, and the
 * search-result snippet. The preview label sits directly above the card it describes.
 */
export function ProfilePreviewPanel({
  expert,
  username,
  headline,
}: Readonly<ProfilePreviewPanelProps>): React.JSX.Element {
  const labelId = useId();
  const completenessFields = [
    { label: 'Profile photo', done: !!expert.avatarUrl },
    { label: 'Headline', done: !!expert.headline },
    { label: 'Bio (min 80 chars)', done: (expert.bio?.length ?? 0) >= 80 },
    { label: 'Username', done: username.length >= 3 },
  ];

  return (
    <div className="flex flex-col gap-5">
      <SettingsCard data-testid="preview-completeness" className="px-[18px] py-4">
        <CompletenessBar fields={completenessFields} />
      </SettingsCard>

      <section aria-labelledby={labelId} className="flex flex-col gap-3.5">
        <div className="flex items-center gap-2">
          <Eye className="text-muted-foreground h-[15px] w-[15px]" aria-hidden="true" />
          <h3
            id={labelId}
            className="text-muted-foreground text-[12.5px] font-semibold tracking-[0.03em] uppercase"
          >
            Live preview
          </h3>
          <span
            aria-hidden="true"
            className="bg-success ml-0.5 h-1.5 w-1.5 rounded-full motion-safe:animate-pulse"
          />
        </div>

        <div data-testid="preview-card">
          <ExpertCard expert={expert} />
        </div>

        {username.length >= 3 && <CopyableUrl username={username} />}

        {headline && (
          <SettingsCard data-testid="preview-snippet" className="px-4 py-3.5">
            <SettingsEyebrow as="p" className="mb-2">
              Search result snippet
            </SettingsEyebrow>
            <p className="text-primary text-[13.5px] font-medium">
              {expert.name} &middot; Salesforce Expert
            </p>
            <p className="text-success-strong my-0.5 text-xs break-all">
              balo.expert/experts/{username || 'your-username'}
            </p>
            <p className="text-muted-foreground line-clamp-2 text-[12.5px] leading-relaxed">
              {headline}
            </p>
          </SettingsCard>
        )}
      </section>
    </div>
  );
}

function CopyableUrl({ username }: Readonly<{ username: string }>): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const url = `balo.expert/experts/${username}`;

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`https://${url}`);
      setCopied(true);
      toast.success('Profile URL copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy the URL. Select it and copy it manually.");
    }
  }, [url]);

  return (
    <div data-testid="preview-url" className="flex min-w-0 items-center gap-1">
      <span className="text-primary min-w-0 text-[12.5px] break-all">{url}</span>
      <button
        type="button"
        onClick={handleCopy}
        className="text-primary/70 hover:text-primary hover:bg-primary/10 focus-visible:ring-ring/50 inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-[3px]"
        aria-label="Copy profile URL"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
