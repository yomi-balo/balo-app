'use client';

import { useRouter } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-400 (D1a's 0-companies arm) — full-step replacement rendered in place of Step 1 the
 * moment the wrapper opens. Not a booking error: an invitation to finish setup.
 */
export function OnboardingRoutingState({
  expertFirstName,
  onClose,
}: Readonly<{ expertFirstName: string | null; onClose: () => void }>): React.JSX.Element {
  const router = useRouter();

  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <span className="bg-muted flex h-14 w-14 items-center justify-center rounded-xl p-4">
        <Building2 className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <div className="max-w-[340px] space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold">
          Let&apos;s finish setting up your company
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Consultations are billed to a company account, and you&apos;re not part of one yet on
          Balo. Add or join a company to book with {expertFirstName ?? 'this expert'}.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          onClick={() => {
            onClose();
            router.push('/onboarding');
          }}
        >
          Set up my company
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Not now
        </Button>
      </div>
    </div>
  );
}
