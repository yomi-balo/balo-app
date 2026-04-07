import { Eye, ShieldCheck, Zap } from 'lucide-react';

const TRUST_ITEMS = [
  { icon: Eye, label: 'We only read your event times' },
  { icon: ShieldCheck, label: 'Details never shared with clients' },
  { icon: Zap, label: 'Syncs every 5 minutes' },
] as const;

export function CalendarTrustRow(): React.JSX.Element {
  return (
    <div className="text-muted-foreground mt-4 flex items-start justify-between gap-4 text-xs">
      {TRUST_ITEMS.map(({ icon: Icon, label }) => (
        <div key={label} className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
