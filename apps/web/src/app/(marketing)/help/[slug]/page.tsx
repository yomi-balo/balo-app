import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { helpContent } from '@/lib/help/content';
import { HELP_CATEGORIES } from '@/lib/help/categories';
import {
  helpGuideHref,
  parseHelpSide,
  parseHelpSource,
  resolveGuideSide,
} from '@/lib/help/audience';
import { GuideFeedback } from '../_components/guide-feedback';
import { GuideHeader } from '../_components/guide-header';
import { GuideRows } from '../_components/guide-rows';
import { GuideSection } from '../_components/guide-section';
import { GuideViewTracker } from '../_components/guide-view-tracker';
import { HelpBlocks } from '../_components/help-blocks';
import { MobileSectionJump } from '../_components/mobile-section-jump';
import { SectionRail } from '../_components/section-rail';
import { SupportBlock } from '../_components/support-block';

interface HelpGuidePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({
  params,
}: Readonly<Pick<HelpGuidePageProps, 'params'>>): Promise<Metadata> {
  const { slug } = await params;
  const guide = helpContent.findGuide(slug);
  if (guide === undefined) return {};
  return { title: `${guide.title} — Balo help`, description: guide.summary };
}

export default async function HelpGuidePage({
  params,
  searchParams,
}: Readonly<HelpGuidePageProps>): Promise<React.JSX.Element> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const guide = helpContent.findGuide(slug);
  if (guide === undefined) notFound();

  const side = resolveGuideSide(guide.audience, parseHelpSide(query.for));
  const source = parseHelpSource(query.src);
  const categoryId = guide.category[side];
  const category = HELP_CATEGORIES[side].find((candidate) => candidate.id === categoryId);
  const related = helpContent.findSummaries(guide.related);
  const steps = guide.sections.map(({ n, title }) => ({ n, title }));

  return (
    <main className="mx-auto max-w-[1080px] px-5 pt-6 pb-12 md:px-10 md:pt-11 md:pb-[72px]">
      <div className="flex items-start gap-14">
        {steps.length > 0 ? <SectionRail slug={slug} steps={steps} /> : null}
        <article className="max-w-[680px] min-w-0 flex-1">
          <GuideHeader guide={guide} side={side} category={category} />
          {steps.length > 0 ? (
            <MobileSectionJump key={`jump-${slug}`} slug={slug} steps={steps} />
          ) : null}
          <div className="mt-9 md:mt-12">
            {guide.intro.length > 0 ? <HelpBlocks blocks={guide.intro} /> : null}
            <div className={guide.intro.length > 0 ? 'mt-12' : undefined}>
              {guide.sections.map((section) => (
                <GuideSection key={section.n} section={section} />
              ))}
            </div>
          </div>
          <GuideFeedback key={`feedback-${slug}`} slug={slug} />
          {related.length > 0 ? (
            <section aria-labelledby="help-related" className="mt-12">
              <h2 id="help-related" className="text-foreground m-0 mb-3 text-lg font-bold">
                Related guides
              </h2>
              <GuideRows
                items={related}
                hrefFor={(relatedSlug) => {
                  const target = related.find((item) => item.slug === relatedSlug);
                  return helpGuideHref(relatedSlug, {
                    for: target?.audience.includes(side) ? side : undefined,
                    src: 'related',
                  });
                }}
              />
            </section>
          ) : null}
          <SupportBlock />
          <GuideViewTracker slug={slug} audience={side} source={source} />
        </article>
      </div>
    </main>
  );
}
