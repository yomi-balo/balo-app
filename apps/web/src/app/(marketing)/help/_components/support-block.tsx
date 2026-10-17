import { Mail } from 'lucide-react';

/** The shared "Still stuck?" footer of the help index and every guide. */
export function SupportBlock(): React.JSX.Element {
  return (
    <section
      aria-labelledby="help-support"
      className="bg-mist border-line mt-14 flex flex-col items-start justify-between gap-4 rounded-2xl border px-6 py-[22px] md:flex-row md:items-center"
    >
      <div>
        <h2 id="help-support" className="text-foreground m-0 text-lg font-bold">
          Still stuck?
        </h2>
        <p className="text-muted-foreground mt-1 text-[15px] leading-normal">
          Reach us any time at support@getbalo.com.
        </p>
      </div>
      <a
        href="mailto:support@getbalo.com"
        className="bg-card text-foreground border-line hover:bg-accent focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-[10px] border px-4 py-2.5 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none"
      >
        <Mail aria-hidden="true" className="size-4" />
        Email support
      </a>
    </section>
  );
}
