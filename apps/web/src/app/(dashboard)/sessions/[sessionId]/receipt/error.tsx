'use client';

import { StatementError } from '../_components/statement-error';

export default function ReceiptError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return <StatementError lens="client" reset={reset} />;
}
