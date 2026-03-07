import { Video } from 'lucide-react';
import { IconBadge } from '@/components/balo/icon-badge';

export default function ConsultationsPage(): React.JSX.Element {
  return (
    <div>
      <div className="mb-8">
        <h2 className="text-foreground text-2xl font-semibold">Consultations</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Manage your consultations and bookings.
        </p>
      </div>
      <div className="border-border bg-card rounded-xl border p-16 text-center">
        <IconBadge icon={Video} color="#2563EB" size={56} iconSize={26} className="mx-auto mb-4" />
        <p className="text-foreground text-base font-semibold">Coming soon</p>
        <p className="text-muted-foreground mt-1 text-sm">This feature is being built</p>
      </div>
    </div>
  );
}
