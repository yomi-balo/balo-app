import { Building2 } from 'lucide-react';
import { BaloCard } from '@/components/balo/card/balo-card';

/**
 * Agency lens empty state: the agency has teammates but no project engagements yet. Framed as an
 * invitation, with no button because there is nothing for an owner to start from here.
 */

export function AgencyEmptyState({
  agencyName,
}: Readonly<{ agencyName: string }>): React.JSX.Element {
  return (
    <BaloCard className="px-8 py-12 text-center">
      <span className="bg-success/10 mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
        <Building2 className="text-success h-6 w-6" aria-hidden="true" />
      </span>
      <h3 className="text-foreground text-lg font-semibold">
        {agencyName}&apos;s projects will gather here
      </h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
        When a client kicks off a project with a {agencyName} expert, it shows up here. You can open
        any of them and step in on delivery.
      </p>
    </BaloCard>
  );
}
