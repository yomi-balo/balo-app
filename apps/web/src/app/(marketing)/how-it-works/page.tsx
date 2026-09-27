import type { Metadata } from 'next';
import { LifeBuoy } from 'lucide-react';
import { MarketingPlaceholder } from '@/components/marketing/marketing-placeholder';

export const metadata: Metadata = {
  title: 'How it works — Balo',
  robots: { index: false },
};

/** Placeholder for the marketing header's How it works link until the real page is built. */
export default function HowItWorksPage(): React.JSX.Element {
  return (
    <MarketingPlaceholder
      icon={LifeBuoy}
      title="How it works"
      body="We're putting together a walkthrough of how Balo connects you with a vetted Salesforce expert. It will be here soon."
      primaryCta={{ label: 'Find an expert', href: '/experts' }}
    />
  );
}
