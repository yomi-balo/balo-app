'use client';

import { Mail } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { track, HELP_EVENTS, type HelpAudience } from '@/lib/analytics';
import { helpGuideHref, helpIndexHref } from '@/lib/help/audience';
import type { HelpCategoryGroup } from '@/lib/help/types';
import { AudienceTabs } from './audience-tabs';
import { GuideRows } from './guide-rows';
import { SupportBlock } from './support-block';

interface HelpIndexViewProps {
  initialAudience: HelpAudience;
  groups: Readonly<Record<HelpAudience, readonly HelpCategoryGroup[]>>;
  signedIn: boolean;
}

const SIDE_LABEL: Readonly<Record<HelpAudience, string>> = {
  client: 'clients',
  expert: 'experts',
};

const EMPTY_BODY: Readonly<Record<HelpAudience, string>> = {
  client:
    'Our support team will walk you through anything, from your first booking to getting paid.',
  expert:
    'Our support team will walk you through anything, from setting up your profile to getting paid.',
};

interface EmptySideProps {
  audience: HelpAudience;
  otherHasGuides: boolean;
  onBrowseOther: () => void;
}

function EmptySide({
  audience,
  otherHasGuides,
  onBrowseOther,
}: Readonly<EmptySideProps>): React.JSX.Element {
  const other: HelpAudience = audience === 'client' ? 'expert' : 'client';
  return (
    <section
      aria-labelledby="help-empty"
      className="bg-mist border-line flex min-w-0 flex-1 flex-col items-start gap-4 rounded-2xl border px-6 py-[22px]"
    >
      <div>
        <h2 id="help-empty" className="text-foreground m-0 text-lg font-bold">
          Need a hand with Balo?
        </h2>
        <p className="text-muted-foreground mt-1 max-w-[560px] text-[15px] leading-normal">
          {EMPTY_BODY[audience]}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <a
          href="mailto:support@getbalo.com"
          className="bg-card text-foreground border-line hover:bg-accent focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-[10px] border px-4 py-2.5 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none"
        >
          <Mail aria-hidden="true" className="size-4" />
          Email support
        </a>
        {otherHasGuides ? (
          <button
            type="button"
            onClick={onBrowseOther}
            className="text-primary focus-visible:ring-ring min-h-11 rounded-md px-2 text-sm font-semibold underline-offset-2 outline-none hover:underline focus-visible:ring-2"
          >
            Browse guides for {SIDE_LABEL[other]}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** The `/help` index: side switch, topic nav and the guide list for the chosen side. */
export function HelpIndexView({
  initialAudience,
  groups,
  signedIn,
}: Readonly<HelpIndexViewProps>): React.JSX.Element {
  const [audience, setAudience] = useState<HelpAudience>(initialAudience);
  const viewedRef = useRef(false);

  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    track(HELP_EVENTS.INDEX_VIEWED, { audience: initialAudience, signed_in: signedIn });
  }, [initialAudience, signedIn]);

  const handleChange = useCallback(
    (next: HelpAudience) => {
      if (next === audience) return;
      setAudience(next);
      globalThis.history.replaceState(null, '', helpIndexHref(next));
      track(HELP_EVENTS.AUDIENCE_SWITCHED, { from: audience, to: next });
    },
    [audience]
  );

  const categories = groups[audience];

  return (
    <main className="mx-auto max-w-[1080px] px-5 pt-7 pb-12 md:px-10 md:pt-[52px] md:pb-[72px]">
      <h1 className="text-foreground m-0 text-[30px] leading-[1.1] font-bold tracking-tight md:text-[40px]">
        Balo help
      </h1>
      <p className="text-muted-foreground mt-2.5 max-w-[560px] text-base leading-relaxed md:text-[17px]">
        Step-by-step guides for using Balo. Pick whether you hire experts or work as one.
      </p>

      <div className="mt-6 md:mt-8">
        <AudienceTabs audience={audience} onChange={handleChange} />
      </div>

      <div
        key={audience}
        id="help-panel"
        role="tabpanel"
        aria-labelledby={`help-tab-${audience}`}
        className="animate-in fade-in slide-in-from-bottom-1.5 mt-8 flex items-start gap-14 duration-200 motion-reduce:animate-none md:mt-[52px]"
      >
        {categories.length === 0 ? (
          <EmptySide
            audience={audience}
            otherHasGuides={groups[audience === 'client' ? 'expert' : 'client'].length > 0}
            onBrowseOther={() => handleChange(audience === 'client' ? 'expert' : 'client')}
          />
        ) : (
          <>
            <nav aria-label="Topics" className="sticky top-24 hidden w-[196px] shrink-0 lg:block">
              <ul className="m-0 grid list-none gap-0.5 p-0">
                {categories.map((category) => (
                  <li key={category.id}>
                    <a
                      href={`#topic-${category.id}`}
                      className="text-muted-foreground hover:bg-mist hover:text-foreground focus-visible:ring-ring -mx-2.5 block rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none"
                    >
                      {category.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="min-w-0 flex-1">
              {categories.map((category) => (
                <section
                  key={category.id}
                  id={`topic-${category.id}`}
                  aria-labelledby={`topic-${category.id}-title`}
                  className="scroll-mt-24 pt-11 first:pt-0"
                >
                  <h2
                    id={`topic-${category.id}-title`}
                    className="text-foreground m-0 text-xl font-bold tracking-tight"
                  >
                    {category.title}
                  </h2>
                  <p className="text-muted-foreground mt-1 mb-3 text-sm leading-normal">
                    {category.blurb}
                  </p>
                  <GuideRows
                    items={category.guides}
                    hrefFor={(slug) => helpGuideHref(slug, { for: audience, src: 'index' })}
                  />
                </section>
              ))}
              <SupportBlock />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
