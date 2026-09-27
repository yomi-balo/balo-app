import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface MarketingPlaceholderProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
  /** The page's forward action. Omitted where "Find an expert" would be the wrong audience. */
  readonly primaryCta?: { readonly label: string; readonly href: string };
}

/**
 * A temporary "coming soon" page for a marketing nav link whose real page isn't built yet
 * (How it works, For experts, Pricing). Server component, static copy only. Pages rendering it
 * set `robots: { index: false }` so a placeholder never lands in search results.
 */
export function MarketingPlaceholder({
  icon: Icon,
  title,
  body,
  primaryCta,
}: Readonly<MarketingPlaceholderProps>): React.JSX.Element {
  return (
    <main className="bg-background flex min-h-[70vh] flex-col items-center justify-center px-4 py-24 text-center">
      <div className="bg-primary/10 text-primary mb-5 rounded-2xl p-4">
        <Icon className="h-7 w-7" aria-hidden="true" />
      </div>
      <p className="text-primary text-xs font-semibold tracking-wider uppercase">Coming soon</p>
      <h1 className="text-foreground mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h1>
      <p className="text-muted-foreground mt-3 max-w-md text-base leading-relaxed">{body}</p>
      <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
        {primaryCta !== undefined && (
          <Button asChild size="lg">
            <Link href={primaryCta.href}>{primaryCta.label}</Link>
          </Button>
        )}
        <Button asChild size="lg" variant="outline">
          <Link href="/">Back to home</Link>
        </Button>
      </div>
    </main>
  );
}
