'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  track,
  EXPERT_PROFILE_EVENTS,
  type ExpertProfileCta,
  type ExpertProfileSection,
} from '@/lib/analytics';
import type { ExpertProfileView, ProfileSectionKey } from '@/components/expert/profile';
import type { ProjectRequestTaxonomies } from '@/lib/project-request/load-project-taxonomy';
import { useIsMobile } from '@/hooks/use-mobile';
import { Hero } from './hero';
import { StickyNav, type NavSection } from './sticky-nav';
import { AboutSection } from './about-section';
import { ExpertiseSection } from './expertise-section';
import { QuickStartsSection } from './quick-starts-section';
import { WorkSection } from './work-section';
import { ReviewsSection } from './reviews-section';
import { BookingCard } from './booking-card';
import { ExpertProfileAnalytics } from './expert-profile-analytics';
import { ProjectRequestPanel } from '@/components/balo/project-request/panel';

interface ExpertProfileClientProps {
  view: ExpertProfileView;
  portraitUrl: string | null;
  isLoggedIn: boolean;
  projectTaxonomies: ProjectRequestTaxonomies;
}

const SECTION_LABELS: Record<ProfileSectionKey, string> = {
  about: 'About',
  expertise: 'Expertise',
  quickstarts: 'Quick Starts',
  work: 'Work',
  reviews: 'Reviews',
};

/**
 * Top-level client orchestrator: owns scroll-spy state + the computed
 * `sections[]` (data-driven so Work disappears cleanly when absent), the
 * stubbed CTA handlers, and mounts the analytics tracker. The grid↔stack switch
 * is CSS-only at the 820px breakpoint (single source of truth); `useIsMobile(820)`
 * is used solely for the analytics `viewport` value, NOT for layout. The
 * right-column `BookingCard` is a DIRECT child of the two-column grid so its
 * `sticky` works.
 */
export function ExpertProfileClient({
  view,
  portraitUrl,
  isLoggedIn,
  projectTaxonomies,
}: Readonly<ExpertProfileClientProps>): React.JSX.Element {
  const isMobile = useIsMobile(820);

  const sections = useMemo<NavSection[]>(() => {
    const keys: ProfileSectionKey[] = ['about', 'expertise', 'quickstarts'];
    if (view.workHistory.length > 0) keys.push('work');
    keys.push('reviews');
    return keys.map((key) => ({ key, label: SECTION_LABELS[key] }));
  }, [view.workHistory.length]);

  const firstSection = sections[0]?.key ?? 'about';
  const [activeNav, setActiveNav] = useState<ProfileSectionKey>(firstSection);

  // ProjectRequestPanel (BAL-253/BAL-264) — opened by the `project` CTA from both
  // the BookingCard and the QuickStarts empty-state. The trigger + analytics stay
  // here (profile-specific); the panel itself is a Projects-owned reusable module.
  const [projectOpen, setProjectOpen] = useState(false);

  // Suppress scroll-spy updates briefly while a programmatic smooth-scroll runs.
  const jumpingRef = useRef(false);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleJump = useCallback((key: ProfileSectionKey) => {
    setActiveNav(key);
    jumpingRef.current = true;
    if (jumpTimer.current) clearTimeout(jumpTimer.current);
    jumpTimer.current = setTimeout(() => {
      jumpingRef.current = false;
    }, 700);
    document
      .getElementById(`section-${key}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(
    () => () => {
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
    },
    []
  );

  // Scroll-spy: observe only the mounted section anchors.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (jumpingRef.current) return;
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const top = visible[0];
        if (!top) return;
        const key = (top.target as HTMLElement).dataset.section as ProfileSectionKey | undefined;
        if (key) setActiveNav(key);
      },
      { rootMargin: '-72px 0px -55% 0px', threshold: 0 }
    );

    for (const section of sections) {
      const el = document.getElementById(`section-${section.key}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);

  // ── Stubbed CTA handlers — the seam BAL-252/255 still replace (book/message) ──
  const fireCta = useCallback(
    (cta: ExpertProfileCta) => {
      track(EXPERT_PROFILE_EVENTS.PROFILE_CTA_CLICKED, { expert_id: view.expertId, cta });
      toast('Coming soon', {
        description: 'This flow is on its way.',
      });
    },
    [view.expertId]
  );

  const onBook = useCallback(() => fireCta('book'), [fireCta]);
  const onMessage = useCallback(() => fireCta('message'), [fireCta]);

  // `project` is wired (BAL-253): keep the profile-level CTA event, then open
  // the ProjectRequestPanel instead of the "Coming soon" toast.
  const onStartProject = useCallback(() => {
    track(EXPERT_PROFILE_EVENTS.PROFILE_CTA_CLICKED, { expert_id: view.expertId, cta: 'project' });
    setProjectOpen(true);
  }, [view.expertId]);

  const analyticsSections = useMemo<ExpertProfileSection[]>(
    () => sections.map((s) => s.key),
    [sections]
  );

  return (
    <div className="bg-background min-h-screen">
      <Hero view={view} portraitUrl={portraitUrl} />
      <StickyNav sections={sections} active={activeNav} onJump={handleJump} />

      <div className="mx-auto max-w-[1120px] px-5 pb-12 md:px-8 md:pb-16">
        <div className="grid grid-cols-1 items-start gap-4 pt-5 min-[820px]:grid-cols-[minmax(0,1fr)_360px] min-[820px]:gap-7 min-[820px]:pt-7">
          {/* Left column */}
          <div className="flex flex-col gap-4">
            <section id="section-about" data-section="about" className="scroll-mt-[72px]">
              <AboutSection bio={view.bio} firstName={view.firstName} />
            </section>
            <section id="section-expertise" data-section="expertise" className="scroll-mt-[72px]">
              <ExpertiseSection
                competencies={view.competencies}
                certifications={view.certifications}
              />
            </section>
            <section
              id="section-quickstarts"
              data-section="quickstarts"
              className="scroll-mt-[72px]"
            >
              <QuickStartsSection
                packages={[]}
                firstName={view.firstName}
                onStartProject={onStartProject}
              />
            </section>
            {view.workHistory.length > 0 && (
              <section id="section-work" data-section="work" className="scroll-mt-[72px]">
                <WorkSection workHistory={view.workHistory} firstName={view.firstName} />
              </section>
            )}
            <section id="section-reviews" data-section="reviews" className="scroll-mt-[72px]">
              <ReviewsSection firstName={view.firstName} />
            </section>
          </div>

          {/* Right column — DIRECT grid child (sticky context). */}
          <BookingCard
            expertId={view.expertId}
            rate={view.rate}
            availableForWork={view.availableForWork}
            onBook={onBook}
            onStartProject={onStartProject}
            onMessage={onMessage}
          />
        </div>
      </div>

      <ProjectRequestPanel
        open={projectOpen}
        onClose={() => setProjectOpen(false)}
        entryPoint="profile"
        expertProfileId={view.expertId}
        expert={{
          name: view.name,
          firstName: view.firstName,
          initials: view.initials,
          avatarKey: view.avatarKey,
        }}
        projectTaxonomies={projectTaxonomies}
      />

      <ExpertProfileAnalytics
        expertId={view.expertId}
        agencyId={view.agencyId}
        viewport={isMobile ? 'mobile' : 'desktop'}
        isLoggedIn={isLoggedIn}
        sections={analyticsSections}
      />
    </div>
  );
}
