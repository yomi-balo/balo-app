'use client';

import { useEffect, useRef } from 'react';
import { track, HELP_EVENTS, type HelpArticleSource, type HelpAudience } from '@/lib/analytics';

interface GuideViewTrackerProps {
  slug: string;
  audience: HelpAudience;
  source: HelpArticleSource;
}

/** Fires `help_article_viewed` once per guide; renders nothing. */
export function GuideViewTracker({
  slug,
  audience,
  source,
}: Readonly<GuideViewTrackerProps>): null {
  const trackedSlug = useRef<string | null>(null);

  useEffect(() => {
    if (trackedSlug.current === slug) return;
    trackedSlug.current = slug;
    track(HELP_EVENTS.ARTICLE_VIEWED, { slug, audience, source });
  }, [slug, audience, source]);

  return null;
}
