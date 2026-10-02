import { Sparkles } from 'lucide-react';
import { getAvatarUrl } from '@/lib/storage/avatar-url';

interface ExpertAvatarMediaProps {
  /** R2 key or http URL for the expert's avatar (resolved client-side). */
  avatarKey: string | null | undefined;
  initials: string;
}

/** The expert's avatar tile — their photo when there is one, otherwise their initials. */
export function ExpertAvatarMedia({
  avatarKey,
  initials,
}: Readonly<ExpertAvatarMediaProps>): React.JSX.Element {
  const avatarUrl = getAvatarUrl(avatarKey ?? null, 'thumbnail');
  return (
    <span className="border-border bg-muted flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatar from Cloudflare Image Resizing
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-foreground text-xs font-semibold">{initials}</span>
      )}
    </span>
  );
}

/** The icon tile for a matched ("find me an expert") recipient. */
export function MatchMedia(): React.JSX.Element {
  return (
    <span className="border-primary/25 bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full border">
      <Sparkles className="h-4.5 w-4.5" aria-hidden="true" />
    </span>
  );
}
