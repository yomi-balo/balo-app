import { Loader2 } from 'lucide-react';

/** The SMS landing's loading state: shown while the ring is read and the viewer is redirected. */
export default function CallNowLoading(): React.JSX.Element {
  return (
    <output className="bg-background text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-3">
      <Loader2 className="size-6 animate-spin" aria-hidden="true" />
      <span className="text-sm">Opening your call…</span>
    </output>
  );
}
