import Link from 'next/link';
import { Video, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-550 (§7.5) — the lens's two empty states. CLAUDE.md's "empty states are invitations,
 * never absence-framed": TRUE-zero explains what starts recording; a windowed/filtered zero
 * offers a way back rather than a bare "nothing here".
 */
export function CaptureHealthEmpty(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-full">
        <Video className="text-muted-foreground size-5" aria-hidden="true" />
      </div>
      <p className="text-foreground max-w-md text-sm font-semibold">
        Nothing has been recorded yet
      </p>
      <p className="text-muted-foreground max-w-md text-[12.5px] leading-relaxed">
        Recording starts when the first Balo Video consultation goes in progress.
      </p>
    </div>
  );
}

interface CaptureHealthFilteredEmptyProps {
  readonly hasCategoryFilter: boolean;
}

export function CaptureHealthFilteredEmpty({
  hasCategoryFilter,
}: Readonly<CaptureHealthFilteredEmptyProps>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-foreground text-sm font-semibold">Nothing in this window.</p>
      <div className="flex gap-2">
        {hasCategoryFilter && (
          <Button asChild variant="outline" size="sm">
            <Link href="?">
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Back to all
            </Link>
          </Button>
        )}
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/health/capture">Reset to the last 30 days</Link>
        </Button>
      </div>
    </div>
  );
}
