import type { ExpertLiveState } from '@balo/shared/experts';
import { cn } from '@/lib/utils';
import { LIVE_STATUS_TOKENS, liveStatusCopyFor } from './live-status-copy';

interface LiveStatusDotProps {
  readonly state: ExpertLiveState;
  /** The ring colour that matches the surface the avatar sits on (`ring-sidebar`, `ring-background`). */
  readonly ringClassName: string;
  /** Announce the status. Off wherever a pill beside the dot already says it. */
  readonly announce?: boolean;
}

/** The avatar's status dot. Decorative to sighted users; the label is for screen readers. */
export function LiveStatusDot({
  state,
  ringClassName,
  announce = true,
}: Readonly<LiveStatusDotProps>): React.JSX.Element {
  const { pill } = liveStatusCopyFor({ state, fixItem: null });
  return (
    <>
      <span
        aria-hidden="true"
        data-live-dot={state}
        className={cn(
          'absolute -right-px -bottom-px size-[11px] rounded-full ring-2',
          LIVE_STATUS_TOKENS[state].dot,
          ringClassName
        )}
      />
      {announce && <span className="sr-only">Marketplace status: {pill}</span>}
    </>
  );
}
