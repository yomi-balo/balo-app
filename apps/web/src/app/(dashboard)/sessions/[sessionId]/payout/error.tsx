'use client';

import { StatementError } from '../_components/statement-error';

export default function PayoutError({
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>): React.JSX.Element {
  return <StatementError lens="expert" reset={reset} />;
}
