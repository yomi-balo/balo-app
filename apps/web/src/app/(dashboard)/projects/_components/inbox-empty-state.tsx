import Link from 'next/link';
import { Briefcase, Coffee, Inbox, Plus, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import type { PortfolioLens } from '@/lib/projects-inbox/resolve-portfolio-lens';
import { NEW_REQUEST_HREF, EXPERT_PROFILE_HREF } from './constants';

/**
 * Per-lens empty state — framed as an INVITATION centred on the next action
 * (balo-ui: "empty states are decisions, not absences"), never "No … yet". Pure
 * + server-safe. The client lens leads with raising a request; the expert lens
 * with completing the profile; the admin lens celebrates a clear queue.
 */

interface InboxEmptyStateProps {
  lens: PortfolioLens;
}

interface EmptyContent {
  icon: typeof Briefcase;
  iconWrap: string;
  iconTone: string;
  title: string;
  body: string;
  cta?: { label: string; href: string; icon: typeof Plus; variant: 'gradient' | 'outline' };
}

const EMPTY_CONTENT: Record<PortfolioLens, EmptyContent> = {
  client: {
    icon: Briefcase,
    iconWrap: 'bg-gradient-to-br from-primary/10 to-violet-500/10',
    iconTone: 'text-primary',
    title: 'Start your first project',
    body: "Tell us what you're trying to get done in Salesforce. Balo matches you with vetted experts — you talk to them, compare proposals, and pick who you work with.",
    cta: {
      label: 'Raise a project request',
      href: NEW_REQUEST_HREF,
      icon: Plus,
      variant: 'gradient',
    },
  },
  expert: {
    icon: Inbox,
    iconWrap: 'bg-violet-500/10',
    iconTone: 'text-violet-600 dark:text-violet-400',
    title: 'No project invitations yet',
    body: 'When Balo matches you to a client request, the invitation lands here. A complete profile gets you matched more often.',
    cta: {
      label: 'Review your expert profile',
      href: EXPERT_PROFILE_HREF,
      icon: User,
      variant: 'outline',
    },
  },
  admin: {
    icon: Coffee,
    iconWrap: 'bg-success/10',
    iconTone: 'text-success',
    title: 'Queue clear 🎉',
    body: 'Nothing to triage and no stalled requests.',
  },
};

export function InboxEmptyState({ lens }: Readonly<InboxEmptyStateProps>): React.JSX.Element {
  const content = EMPTY_CONTENT[lens];
  const Icon = content.icon;

  return (
    <div className="border-border bg-card rounded-2xl border px-8 py-14 text-center">
      <span
        className={cn(
          'mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl',
          content.iconWrap
        )}
      >
        <Icon className={cn('h-6 w-6', content.iconTone)} aria-hidden="true" />
      </span>
      <h3 className="text-foreground text-lg font-semibold">{content.title}</h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
        {content.body}
      </p>
      {content.cta && (
        <div className="mt-5">
          <Button
            asChild
            className={content.cta.variant === 'gradient' ? PROPOSAL_CTA_GRADIENT_CLASS : undefined}
            variant={content.cta.variant === 'gradient' ? 'default' : 'outline'}
          >
            <Link href={content.cta.href}>
              <content.cta.icon className="h-4 w-4" aria-hidden="true" />
              {content.cta.label}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
