import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatementPageShell, StatementCard } from './statement-page-shell';

/**
 * BAL-519 — the ONE centred-notice layout every terminal inline statement state renders into
 * (not-found, rate-limited). Extracted from `statement-not-found.tsx`, whose body the rate-limited
 * state would otherwise have cloned line-for-line: a ~25-line JSX clone measured as duplication on
 * NEW code, and — worse on a money surface — two places for the card padding, the icon size and the
 * back-link affordance to drift apart.
 *
 * PRESENTATIONAL ONLY. It takes finished strings and never reads `STATEMENT_COPY` itself, so each
 * state keeps ownership of its own copy keys and the `pending-MJ` queue stays honest. The icon and
 * the action's destination are both explicit props — the caller decides both, not this component;
 * `StatementNotFound` still derives its icon from `lens`, but `StatementRateLimited` picks a
 * different icon (`Clock`, fix UX2) and a different destination (fix UX1), which is exactly why
 * `lens` was dropped from this component's own props.
 *
 * A plain server component: no state, no handlers, no `'use client'`.
 */
export function StatementNotice({
  icon: Icon,
  heading,
  body,
  actionLabel,
  actionHref = '/dashboard',
}: Readonly<{
  icon: LucideIcon;
  heading: string;
  body: string;
  actionLabel: string;
  actionHref?: string;
}>): React.JSX.Element {
  return (
    <StatementPageShell>
      <StatementCard>
        <div className="text-center">
          <span
            aria-hidden="true"
            className="bg-muted text-muted-foreground mb-4 inline-grid h-13 w-13 place-items-center rounded-xl"
          >
            <Icon className="h-6 w-6" />
          </span>
          <h1 className="text-foreground text-xl font-semibold">{heading}</h1>
          <p className="text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-relaxed">
            {body}
          </p>
          <div className="mt-6 flex justify-center">
            <Button asChild variant="outline" className="min-h-11">
              <Link href={actionHref}>{actionLabel}</Link>
            </Button>
          </div>
        </div>
      </StatementCard>
    </StatementPageShell>
  );
}
