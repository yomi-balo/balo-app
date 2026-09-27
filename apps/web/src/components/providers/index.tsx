'use client';

import { QueryProvider } from './query-provider';
import { PostHogProvider } from './posthog-provider';
import { ThemeProvider } from './theme-provider';
import { AuthModalProvider } from './auth-modal-provider';

interface ProvidersProps {
  children: React.ReactNode;
}

/**
 * BAL-504 — does not take `userId`/`userTraitsJson`. The root layout never reads the session;
 * identify is `<AnalyticsIdentify>`, rendered wherever a caller already has `user` in hand (see
 * `@/lib/auth/impersonation`'s `analyticsIdentifyPropsFor`).
 */
export function Providers({ children }: Readonly<ProvidersProps>): React.JSX.Element {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <QueryProvider>
        <PostHogProvider>
          <AuthModalProvider>{children}</AuthModalProvider>
        </PostHogProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
