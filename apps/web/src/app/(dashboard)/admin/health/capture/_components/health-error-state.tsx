import { AlertTriangle } from 'lucide-react';

/**
 * BAL-550 (§7.8) — the caught-read-failure state, distinct from `admin/error.tsx`'s thrown
 * boundary: `page.tsx` catches `loadCaptureHealth`'s throw, `log.error`s it, and renders this
 * in place of the list rather than re-throwing to the segment error boundary.
 */
export function HealthErrorState(): React.JSX.Element {
  return (
    <div className="border-destructive/30 bg-destructive/5 flex flex-col items-center gap-2 rounded-2xl border p-10 text-center">
      <AlertTriangle className="text-destructive size-6" aria-hidden="true" />
      <p className="text-foreground text-sm font-semibold">Could not load capture health</p>
      <p className="text-muted-foreground max-w-md text-[12.5px] leading-relaxed">
        Something went wrong loading the recording, transcription and recap pipelines. Try
        refreshing the page in a moment.
      </p>
    </div>
  );
}
