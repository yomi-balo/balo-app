import Link from 'next/link';
import { UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 404 for `/experts/[username]`. Triggered by `notFound()` for missing OR gated
 * (unapproved / non-searchable) usernames — both resolve here so an unapproved
 * profile can't be distinguished from a non-existent one (privacy).
 */
export default function ExpertProfileNotFound(): React.JSX.Element {
  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="bg-muted mb-4 rounded-xl p-4">
        <UserX className="text-muted-foreground h-8 w-8" />
      </div>
      <h1 className="text-foreground text-lg font-semibold">
        This expert profile isn&apos;t available
      </h1>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">
        The profile you&apos;re looking for doesn&apos;t exist or isn&apos;t public right now.
      </p>
      <Button asChild className="mt-4">
        <Link href="/experts">Browse experts</Link>
      </Button>
    </div>
  );
}
