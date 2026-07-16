import { Link2Off } from 'lucide-react';

/**
 * The single generic "link not active" card (BAL-386, Surface 3). Rendered for
 * EVERY inactive outcome — invalid / expired / revoked / soft-deleted /
 * rate-limited — with NO differentiation and NO leak of whether the proposal
 * exists. Warm, non-adversarial copy that points the recipient back to the sender.
 */
export function LinkNotActive(): React.JSX.Element {
  return (
    <div className="flex justify-center px-4 pt-6">
      <div className="border-border bg-card w-full max-w-md rounded-2xl border p-8 text-center">
        <span className="border-border bg-muted/40 mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
          <Link2Off className="text-muted-foreground h-6 w-6" aria-hidden="true" />
        </span>
        <h1 className="text-foreground mt-4 text-lg font-semibold">This link isn&apos;t active</h1>
        <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
          Shared proposal links stop working after a while, or when the sender withdraws access. Ask
          the person who shared this with you to send a fresh one — it only takes a moment.
        </p>
        <p className="text-muted-foreground border-border mt-5 border-t pt-4 text-[11.5px]">
          Powered by <span className="text-foreground font-semibold">Balo</span>
        </p>
      </div>
    </div>
  );
}
