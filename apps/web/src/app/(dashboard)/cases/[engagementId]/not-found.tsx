import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * BAL-421 — the case surface's NOT-FOUND page.
 *
 * ⚠⚠ ONE COPY FOR EVERY DENIAL — missing, soft-deleted, cross-tenant, no-capability,
 * no-expert-profile, no-thread, and "this id is a PROJECT engagement, not a case". It
 * deliberately does NOT distinguish "does not exist" from "you cannot see it": a distinct
 * message would confirm the case exists to somebody who may not read it, turning the route
 * into an existence oracle over every `engagements.id` on the platform.
 */
export default function CaseNotFound(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1060px] px-4 py-16 text-center sm:px-6 lg:px-8">
      <span
        aria-hidden="true"
        className="bg-muted text-muted-foreground mb-4 inline-grid h-13 w-13 place-items-center rounded-xl"
      >
        <FileQuestion className="h-6 w-6" />
      </span>
      <h1 className="text-foreground text-xl font-semibold">Case not found</h1>
      <p className="text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-relaxed">
        {"This case doesn't exist, or you don't have access to it."}
      </p>
      <div className="mt-6 flex justify-center">
        <Button asChild variant="outline" className="min-h-11">
          <Link href="/dashboard">Back to your dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
