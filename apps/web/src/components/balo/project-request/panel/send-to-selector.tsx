'use client';

import { Check, Sparkles, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAvatarUrl } from '@/lib/storage/avatar-url';

export type ProjectRouting = 'direct' | 'match';

interface SendToSelectorProps {
  value: ProjectRouting;
  onChange: (routing: ProjectRouting) => void;
  /**
   * Expert display name for the Direct card. Absent → context-free mode: the
   * Direct card renders a neutral "Send to an expert" label + person glyph.
   */
  expertName?: string;
  expertInitials?: string;
  /** R2 key or http URL for the expert's avatar (resolved client-side). */
  expertAvatarKey?: string | null;
}

interface RoutingCardProps {
  selected: boolean;
  onSelect: () => void;
  label: string;
  sublabel: string;
  /** Avatar/initials tile (Direct) or icon tile (Match). */
  media: React.ReactNode;
}

function RoutingCard({
  selected,
  onSelect,
  label,
  sublabel,
  media,
}: Readonly<RoutingCardProps>): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'focus-visible:ring-ring relative flex flex-1 items-center gap-3 rounded-xl border p-3.5 text-left transition-all focus-visible:ring-2 focus-visible:outline-none',
        selected
          ? 'border-primary bg-primary/[0.06]'
          : 'border-border bg-card hover:border-primary/40 hover:bg-primary/[0.03]'
      )}
    >
      {media}
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-sm font-semibold">{label}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">{sublabel}</span>
      </span>
      {selected && (
        <span className="bg-primary text-primary-foreground absolute top-2.5 right-2.5 flex h-4 w-4 items-center justify-center rounded-full">
          <Check className="h-2.5 w-2.5" aria-hidden="true" />
        </span>
      )}
    </button>
  );
}

/**
 * Routing selector — the first decision in the brief (design §2.1). Two
 * selectable cards in a `radiogroup`: Direct (this expert, default) and Match
 * (find me an expert). The chosen value drives the heading, review summary,
 * submit CTA, and the done screen. Modeled on the `PathCard` structure but
 * selectable, not navigational.
 *
 * Expert-bound (an `expertName` is supplied): the Direct card binds to the
 * expert's name + avatar/initials. Context-free (no expert): the Direct card
 * renders a neutral "Send to an expert" label + person glyph and is still
 * selectable (the panel clamps the submit routing to `match` when there is no
 * expert id to route to).
 */
export function SendToSelector({
  value,
  onChange,
  expertName,
  expertInitials,
  expertAvatarKey,
}: Readonly<SendToSelectorProps>): React.JSX.Element {
  const avatarUrl = getAvatarUrl(expertAvatarKey ?? null, 'thumbnail');
  const hasExpert = expertName !== undefined;

  let directMedia: React.ReactNode;
  if (!hasExpert) {
    directMedia = (
      <span className="border-border bg-muted text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full border">
        <User className="h-4.5 w-4.5" aria-hidden="true" />
      </span>
    );
  } else if (avatarUrl) {
    directMedia = (
      <span className="border-border bg-muted flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
        {/* eslint-disable-next-line @next/next/no-img-element -- avatar from Cloudflare Image Resizing */}
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
      </span>
    );
  } else {
    directMedia = (
      <span className="border-border bg-muted flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
        <span className="text-foreground text-xs font-semibold">{expertInitials}</span>
      </span>
    );
  }

  const matchMedia = (
    <span className="border-primary/25 bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full border">
      <Sparkles className="h-4.5 w-4.5" aria-hidden="true" />
    </span>
  );

  return (
    <div
      role="radiogroup"
      aria-label="Send request to"
      className="flex flex-col gap-2.5 sm:flex-row"
    >
      <RoutingCard
        selected={value === 'direct'}
        onSelect={() => onChange('direct')}
        label={hasExpert ? `Send to ${expertName}` : 'Send to an expert'}
        sublabel="They'll reply with a proposal."
        media={directMedia}
      />
      <RoutingCard
        selected={value === 'match'}
        onSelect={() => onChange('match')}
        label="Find me an expert"
        sublabel="We'll match you with the right fit."
        media={matchMedia}
      />
    </div>
  );
}
