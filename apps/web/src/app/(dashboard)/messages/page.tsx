import { MessageSquare } from 'lucide-react';
import { IconBadge } from '@/components/balo/icon-badge';

export default function MessagesPage(): React.JSX.Element {
  return (
    <div>
      <div className="mb-8">
        <h2 className="text-foreground text-2xl font-semibold">Messages</h2>
        <p className="text-muted-foreground mt-1 text-sm">View and manage your conversations.</p>
      </div>
      <div className="border-border bg-card rounded-xl border p-16 text-center">
        <IconBadge
          icon={MessageSquare}
          color="#0891B2"
          size={56}
          iconSize={26}
          className="mx-auto mb-4"
        />
        <p className="text-foreground text-base font-semibold">Coming soon</p>
        <p className="text-muted-foreground mt-1 text-sm">This feature is being built</p>
      </div>
    </div>
  );
}
