import type { Metadata } from 'next';
import { Sparkles } from 'lucide-react';
import { MarketingPlaceholder } from '@/components/marketing/marketing-placeholder';

export const metadata: Metadata = {
  title: 'For experts — Balo',
  robots: { index: false },
};

/**
 * Placeholder for the marketing header's For experts link until the real supply-side page is
 * built. The link deliberately stops here rather than at the expert application.
 */
export default function ForExpertsPage(): React.JSX.Element {
  return (
    <MarketingPlaceholder
      icon={Sparkles}
      title="For experts"
      body="We're building a page about joining Balo as an expert: who we're looking for and how it works. It will be here soon."
    />
  );
}
