import type { Metadata } from 'next';
import { Wallet } from 'lucide-react';
import { MarketingPlaceholder } from '@/components/marketing/marketing-placeholder';

export const metadata: Metadata = {
  title: 'Pricing — Balo',
  robots: { index: false },
};

/** Placeholder for the marketing header's Pricing link until the real page is built. */
export default function PricingPage(): React.JSX.Element {
  return (
    <MarketingPlaceholder
      icon={Wallet}
      title="Pricing"
      body="We're putting together a clear guide to how pricing works on Balo. It will be here soon."
      primaryCta={{ label: 'Find an expert', href: '/experts' }}
    />
  );
}
