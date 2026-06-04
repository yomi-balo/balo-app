import { MessageCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { SectionLabel } from '@/components/expert/profile';

/**
 * "Reviews" — rendered as an empty state in v1 (no reviews table/feature yet).
 * Per the null-gating rule: no stars, no count, no fabricated reviews. The
 * section stays in the nav so the social-proof affordance and scroll-spy set
 * remain stable.
 */
export function ReviewsSection({ firstName }: Readonly<{ firstName: string }>): React.JSX.Element {
  return (
    <Card className="gap-0 p-7">
      <SectionLabel icon={MessageCircle} tone="muted" className="mb-4">
        Reviews
      </SectionLabel>
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="bg-muted mb-4 flex h-12 w-12 items-center justify-center rounded-xl">
          <MessageCircle className="text-muted-foreground h-6 w-6" aria-hidden="true" />
        </div>
        <p className="text-foreground text-sm font-semibold">No reviews yet</p>
        <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">
          Be the first to work with {firstName} and share how it went.
        </p>
      </div>
    </Card>
  );
}
