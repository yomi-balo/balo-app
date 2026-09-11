import { Award, Briefcase, Building2, Globe, Sparkles } from 'lucide-react';
import type {
  ApplicationWithRelations,
  ProductsByCategory,
  CertificationsByCategory,
} from '@balo/db';
import type { SupportType } from '@balo/db';
import { projectRangeLabel } from '@balo/shared/experts';
import {
  buildProductCategoryMap,
  buildProductNamesByCategory,
  buildAssessmentMap,
  buildCertCategoryMap,
  buildDistinctions,
} from '@/lib/expert/application-derived-data';

/**
 * BAL-549 — the staff review page's application sections. Reuses the SECTION COMPOSITION of
 * `(apply)/expert/apply/review/_components/application-review.tsx` (profile, products/skills
 * with the 0–10 support-type ratings, certifications, languages, industries, work history) —
 * restyled for staff with semantic Tailwind tokens (balo-ui-skill), never that component's
 * hardcoded hex design tokens or its applicant-voiced copy ("Your Application", "Back to
 * Dashboard").
 *
 * ⚠⚠ THIS COMPONENT NEVER RENDERS `application.profile.declineNote` — that is staff-only and
 * rendered exactly once, by `DecisionOutcomeBanner`. Do not thread it through here.
 *
 * Server Component: presentational only, no I/O, no interactivity.
 */

interface ApplicationSectionsProps {
  readonly application: ApplicationWithRelations;
  readonly productsByCategory: readonly ProductsByCategory[];
  readonly supportTypes: readonly SupportType[];
  readonly certificationsByCategory: readonly CertificationsByCategory[];
}

function SectionHeading({
  icon: Icon,
  children,
}: Readonly<{ icon: typeof Briefcase; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="mb-3 flex items-center gap-2">
      <div className="bg-muted flex size-[26px] items-center justify-center rounded-[7px]">
        <Icon className="text-muted-foreground size-3.5" aria-hidden="true" />
      </div>
      <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
        {children}
      </p>
    </div>
  );
}

export function ApplicationSections({
  application,
  productsByCategory,
  supportTypes,
  certificationsByCategory,
}: Readonly<ApplicationSectionsProps>): React.JSX.Element {
  const { profile, competencies, certifications, languages, industries, workHistory } = application;

  const productCategoryMap = buildProductCategoryMap(productsByCategory);
  const { productNamesByCategory, uniqueProductIds } = buildProductNamesByCategory(
    competencies,
    productCategoryMap
  );
  const assessmentMap = buildAssessmentMap(competencies);
  const certCategoryMap = buildCertCategoryMap(certificationsByCategory);
  const distinctions = buildDistinctions(profile);

  return (
    <div className="flex flex-col gap-6">
      {/* Experience */}
      <section>
        <SectionHeading icon={Briefcase}>Experience</SectionHeading>
        <div className="border-border bg-card grid grid-cols-1 gap-x-8 gap-y-2 rounded-xl border p-5 sm:grid-cols-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Year started</span>
            <span className="text-foreground font-medium">
              {profile.yearStartedSalesforce ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Projects involved in</span>
            <span className="text-foreground font-medium">
              {projectRangeLabel(profile.projectCountMin)}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Projects as lead</span>
            <span className="text-foreground font-medium">
              {projectRangeLabel(profile.projectLeadCountMin)}
            </span>
          </div>
          {profile.linkedinUrl !== null && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">LinkedIn</span>
              <a
                href={
                  profile.linkedinUrl.startsWith('http')
                    ? profile.linkedinUrl
                    : `https://linkedin.com/in/${profile.linkedinUrl}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary font-medium hover:underline"
              >
                View profile
              </a>
            </div>
          )}
        </div>
      </section>

      {/* Languages */}
      {languages.length > 0 && (
        <section>
          <SectionHeading icon={Globe}>Languages</SectionHeading>
          <div className="border-border bg-card divide-border divide-y rounded-xl border">
            {languages.map((lang) => (
              <div key={lang.id} className="flex items-center gap-3 px-4 py-3">
                <span className="w-6 text-lg">{lang.language.flagEmoji ?? '🌐'}</span>
                <span className="text-foreground flex-1 text-sm font-medium">
                  {lang.language.name}
                </span>
                <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize">
                  {lang.proficiency}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Industries & Distinctions */}
      <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <SectionHeading icon={Building2}>Industries</SectionHeading>
          {industries.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {industries.map((ind) => (
                <span
                  key={ind.id}
                  className="bg-muted text-foreground rounded-full px-3 py-1 text-xs font-medium"
                >
                  {ind.industry.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">None selected</p>
          )}
        </div>
        <div>
          <SectionHeading icon={Award}>Distinctions</SectionHeading>
          {distinctions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {distinctions.map((d) => (
                <span
                  key={d}
                  className="bg-warning/10 text-warning inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"
                >
                  <Award className="size-3.5" aria-hidden="true" />
                  {d}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">None selected</p>
          )}
        </div>
      </section>

      {/* Products */}
      {uniqueProductIds.length > 0 && (
        <section>
          <SectionHeading icon={Sparkles}>Product expertise</SectionHeading>
          <div className="border-border bg-card rounded-xl border p-5">
            {[...productNamesByCategory.entries()].map(([category, productNames]) => (
              <div key={category} className="mb-4 last:mb-0">
                <p className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-wide uppercase">
                  {category}
                </p>
                <div className="flex flex-wrap gap-2">
                  {productNames.map((name) => (
                    <span
                      key={name}
                      className="bg-primary/10 text-primary rounded-full px-3 py-1 text-xs font-medium"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Self-assessment */}
      {assessmentMap.size > 0 && (
        <section>
          <SectionHeading icon={Sparkles}>Self-assessment (0–10)</SectionHeading>
          <div className="flex flex-col gap-3">
            {[...assessmentMap.entries()].map(([productId, { name, ratings }]) => (
              <div key={productId} className="border-border bg-card rounded-xl border p-4">
                <p className="text-foreground mb-2 text-sm font-semibold">{name}</p>
                <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  {supportTypes.map((st) => (
                    <div key={st.id} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{st.name}</span>
                      <span className="text-foreground font-mono font-semibold tabular-nums">
                        {ratings.get(st.slug) ?? 0}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Certifications */}
      {(certifications.length > 0 || profile.trailheadUrl !== null) && (
        <section>
          <SectionHeading icon={Award}>Certifications</SectionHeading>
          {profile.trailheadUrl !== null && (
            <a
              href={
                profile.trailheadUrl.startsWith('http')
                  ? profile.trailheadUrl
                  : `https://trailblazer.me/id/${profile.trailheadUrl}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary mb-3 inline-block text-xs font-medium hover:underline"
            >
              Trailhead profile →
            </a>
          )}
          {certifications.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {certifications.map((cert) => (
                <div
                  key={cert.id}
                  className="border-border bg-card flex items-center gap-3 rounded-xl border px-4 py-3"
                >
                  <Award className="text-warning size-4 shrink-0" aria-hidden="true" />
                  <div>
                    <p className="text-foreground text-sm font-semibold">
                      {cert.certification.name}
                    </p>
                    {certCategoryMap.get(cert.certificationId) !== undefined && (
                      <p className="text-muted-foreground text-[11px]">
                        {certCategoryMap.get(cert.certificationId)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Work history */}
      {workHistory.length > 0 && (
        <section>
          <SectionHeading icon={Briefcase}>Work history</SectionHeading>
          <div className="flex flex-col gap-3">
            {workHistory.map((entry) => (
              <div key={entry.id} className="border-border bg-card rounded-xl border p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-foreground text-sm font-semibold">{entry.role}</p>
                    <p className="text-muted-foreground mt-0.5 text-sm">{entry.company}</p>
                  </div>
                  {entry.isCurrent && (
                    <span className="bg-success/10 text-success rounded-full px-2.5 py-0.5 text-[11px] font-semibold">
                      Current
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
