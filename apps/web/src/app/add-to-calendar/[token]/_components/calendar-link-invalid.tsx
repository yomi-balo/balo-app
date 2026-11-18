import { CalendarX2 } from 'lucide-react';
import { BaloCard } from '@/components/balo/card/balo-card';

/** One neutral card for every unusable link — it never says WHY (tampered, malformed, unsigned). */
export function CalendarLinkInvalid(): React.JSX.Element {
  return (
    <BaloCard className="mx-auto w-full max-w-md p-8 text-center">
      <span className="border-border bg-muted/40 mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
        <CalendarX2 className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="text-foreground mt-4 text-lg font-semibold">
        This calendar link isn&apos;t working
      </h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
        The calendar file attached to your invite email still works — open it to add the call to
        your calendar.
      </p>
    </BaloCard>
  );
}
