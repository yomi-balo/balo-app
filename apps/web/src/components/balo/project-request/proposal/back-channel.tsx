'use client';

import { Calendar, MessageSquare } from 'lucide-react';

interface BackChannelProps {
  /** Display name of the expert the client can reach out to. */
  name: string;
}

/**
 * The demoted "back-channel" beneath the proposal decision: two low-emphasis
 * outline buttons to message the expert or book a call. Presentational only —
 * navigation/intent wiring lives with the route that mounts this.
 */
export function BackChannel({ name }: Readonly<BackChannelProps>): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className="border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring inline-flex min-h-10 items-center gap-2 rounded-[10px] border px-3.5 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <MessageSquare className="h-4 w-4" aria-hidden="true" />
        Message {name}
      </button>
      <button
        type="button"
        className="border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring inline-flex min-h-10 items-center gap-2 rounded-[10px] border px-3.5 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <Calendar className="h-4 w-4" aria-hidden="true" />
        Book a call
      </button>
    </div>
  );
}
