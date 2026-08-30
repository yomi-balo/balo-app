import { WalletWidget } from '@/components/balo/credit/wallet-widget';

/** BAL-503 — Credits & billing's loading skeleton. The widget's own `loading` arm; no new logic. */
export default function Loading(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl">
      <WalletWidget state="loading" />
    </div>
  );
}
