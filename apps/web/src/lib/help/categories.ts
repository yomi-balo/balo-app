import type { HelpAudience } from '@/lib/analytics'; // TYPE-ONLY — erased; no posthog-js at runtime
import type { HelpCategory } from './types';

/** The topics each side's guides are filed under, in display order. */
export const HELP_CATEGORIES: Readonly<Record<HelpAudience, readonly HelpCategory[]>> = {
  client: [
    {
      id: 'getting-started',
      title: 'Getting started',
      blurb: 'Setting up your company and bringing your team in.',
      order: 1,
    },
    {
      id: 'calls',
      title: 'Consultations and calls',
      blurb: 'Booking time with an expert and getting the most from the call.',
      order: 2,
    },
    {
      id: 'cases-projects',
      title: 'Cases and projects',
      blurb: 'Ongoing work with an expert, from a single case to a scoped project.',
      order: 3,
    },
    {
      id: 'credit-billing',
      title: 'Credit and billing',
      blurb: 'How prepaid credit works and how calls are charged.',
      order: 4,
    },
    {
      id: 'your-company',
      title: 'Your company',
      blurb: 'Who is in your company on Balo and how new people join.',
      order: 5,
    },
  ],
  expert: [
    {
      id: 'getting-started',
      title: 'Getting started',
      blurb: 'From your application to your first booking.',
      order: 1,
    },
    {
      id: 'getting-booked',
      title: 'Getting booked',
      blurb: 'Being found by clients and choosing when you take on work.',
      order: 2,
    },
    {
      id: 'calls-cases',
      title: 'Calls and cases',
      blurb: 'Running consultations and keeping track of ongoing work.',
      order: 3,
    },
    {
      id: 'projects',
      title: 'Projects',
      blurb: 'Responding to requests and delivering scoped work.',
      order: 4,
    },
    {
      id: 'getting-paid',
      title: 'Getting paid',
      blurb: 'What you earn and when it reaches you.',
      order: 5,
    },
  ],
};

export function isHelpCategoryId(audience: HelpAudience, id: string): boolean {
  return HELP_CATEGORIES[audience].some((category) => category.id === id);
}
