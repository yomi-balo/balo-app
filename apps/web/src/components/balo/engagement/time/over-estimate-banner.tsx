import { AlertTriangle } from 'lucide-react';

interface OverEstimateBannerProps {
  banner: { title: string; body: string };
}

/** The warning-tone notice that one or more milestones have gone past their estimate. */
export function OverEstimateBanner({
  banner,
}: Readonly<OverEstimateBannerProps>): React.JSX.Element {
  return (
    <div
      role="status"
      className="border-warning/25 bg-warning/10 flex items-start gap-3 rounded-2xl border px-5 py-4"
    >
      <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="text-muted-foreground text-sm leading-relaxed">
        <span className="text-foreground font-semibold">{banner.title}</span> {banner.body}
      </p>
    </div>
  );
}
