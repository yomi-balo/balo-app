'use client';

import { useState, useCallback } from 'react';
import { Eye, Link, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { ExpertCard } from '@/components/expert';
import type { ExpertCardData } from '@/components/expert';
import { CompletenessBar } from './completeness-bar';

interface ProfilePreviewPanelProps {
  expert: ExpertCardData;
  username: string;
  headline: string;
}

export function ProfilePreviewPanel({
  expert,
  username,
  headline,
}: Readonly<ProfilePreviewPanelProps>): React.JSX.Element {
  const completenessFields = [
    { label: 'Profile photo', done: !!expert.avatarKey },
    { label: 'Headline', done: !!expert.title && expert.title !== 'Salesforce Expert' },
    { label: 'Bio (min 80 chars)', done: (expert.bio?.length ?? 0) >= 80 },
    { label: 'Username', done: username.length >= 3 },
  ];

  return (
    <div>
      {/* Preview label */}
      <div className="bg-muted border-border/50 mb-3.5 inline-flex items-center gap-2 rounded-lg border px-3 py-2">
        <Eye className="text-muted-foreground h-3.5 w-3.5" />
        <span className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
          Live preview
        </span>
        <div className="bg-success h-1.5 w-1.5 animate-pulse rounded-full" />
      </div>

      {/* Expert card */}
      <ExpertCard expert={expert} />

      {/* Profile URL preview */}
      {username && username.length >= 3 && <CopyableUrl username={username} />}

      {/* Completeness */}
      <Card className="mt-3 p-4">
        <CompletenessBar fields={completenessFields} />
      </Card>

      {/* Search snippet preview */}
      {headline && (
        <div className="mt-3">
          <p className="text-muted-foreground mb-2 text-[10px] font-semibold tracking-wider uppercase">
            Search result snippet
          </p>
          <div className="border-border bg-card rounded-lg border p-3">
            <p className="text-primary text-xs font-semibold">
              {expert.name} &middot; Salesforce Expert
            </p>
            <p className="text-muted-foreground mt-0.5 mb-1 text-[11px]">
              balo.expert/experts/{username || 'your-username'}
            </p>
            <p className="text-muted-foreground line-clamp-2 text-[11px] leading-relaxed">
              {headline}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyableUrl({ username }: { username: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const url = `balo.expert/experts/${username}`;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(`https://${url}`);
    setCopied(true);
    toast.success('Profile URL copied');
    setTimeout(() => setCopied(false), 2000);
  }, [url]);

  return (
    <div className="bg-primary/5 border-primary/20 animate-in fade-in mt-3 flex items-center gap-2 rounded-lg border p-2.5 duration-300">
      <Link className="text-primary h-3.5 w-3.5 shrink-0" />
      <span className="text-primary flex-1 text-xs font-medium break-all">{url}</span>
      <button
        type="button"
        onClick={handleCopy}
        className="text-primary/60 hover:text-primary shrink-0 transition-colors"
        aria-label="Copy profile URL"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
