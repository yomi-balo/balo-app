import { FolderKanban } from 'lucide-react';
import { IconBadge } from '@/components/balo/icon-badge';

export default function ProjectsPage(): React.JSX.Element {
  return (
    <div>
      <div className="mb-8">
        <h2 className="text-foreground text-2xl font-semibold">Projects</h2>
        <p className="text-muted-foreground mt-1 text-sm">Manage your projects and deliverables.</p>
      </div>
      <div className="border-border bg-card rounded-xl border p-16 text-center">
        <IconBadge
          icon={FolderKanban}
          color="#7C3AED"
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
