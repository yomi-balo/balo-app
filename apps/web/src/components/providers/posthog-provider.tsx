'use client';

import { useEffect } from 'react';
import { initAnalytics, analytics } from '@/lib/analytics';

interface PostHogProviderProps {
  children: React.ReactNode;
  userId?: string;
  /** JSON-serialized traits string for stable useEffect dependency comparison. */
  userTraitsJson?: string;
}

export function PostHogProvider({
  children,
  userId,
  userTraitsJson,
}: Readonly<PostHogProviderProps>): React.JSX.Element {
  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    if (userId && userTraitsJson) {
      analytics.identify(userId, JSON.parse(userTraitsJson) as Record<string, unknown>);
    }
  }, [userId, userTraitsJson]);

  return <>{children}</>;
}
