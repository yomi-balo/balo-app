'use client';

import { QueryProvider } from './query-provider';
import { PostHogProvider } from './posthog-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <PostHogProvider>{children}</PostHogProvider>
    </QueryProvider>
  );
}
