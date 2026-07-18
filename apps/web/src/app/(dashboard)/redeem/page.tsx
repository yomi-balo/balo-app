import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { RedeemPromoPanel } from './_components/redeem-promo-panel';

/**
 * Standalone redeem surface (BAL-383). Server Component: resolve the session user (the
 * (dashboard) layout gates onboarding/drift; null here is the unauthenticated edge →
 * `/login`), then render the client panel with the session company context. `companyId`
 * is ALWAYS present (personal workspace or real company) and resolves "which wallet" the
 * grant binds to. The MANAGE_BILLING gate lives in the Server Action, not the page — the
 * page renders the surface for any signed-in user and the action refuses warmly.
 */

export const metadata: Metadata = {
  title: 'Redeem a promo code — Balo',
  robots: { index: false, follow: false },
};

export default async function RedeemPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  return (
    <div className="py-6">
      <RedeemPromoPanel companyName={user.companyName} companyId={user.companyId} />
    </div>
  );
}
