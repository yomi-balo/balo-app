import { Award, Briefcase, Building2, Clock, Globe, Lock, Sparkles } from 'lucide-react';
import type {
  ApplicationWithRelations,
  ProductsByCategory,
  CertificationsByCategory,
  SupportType,
  StaffSelfRating,
} from '@balo/db';
import { projectRangeLabel } from '@balo/shared/experts';
import { formatPeriod } from '@/lib/expert-profile/profile-view';
import { RichText } from '@/components/balo/project-request/rich-text';
import { sanitizeResponsibilitiesHtml } from '@/lib/sanitize/work-history-html';
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
 * ⚠ DATES HERE ARE UTC MONTH-YEAR, AND THAT DOES NOT CONTRADICT THE VIEWER-LOCAL DECISION
 * TIMESTAMP (web-review fix round, W2/W4). A work-history tenure is a MONTH-GRANULARITY fact the
 * applicant typed ("Nov 2017 — Apr 2020"), so it is rendered by the SHIPPED `formatPeriod`, which
 * reads `getUTC*` — one label for every reader, and never the deployment's timezone (fix-round
 * F15's point). `decided_at` is a different question — an INSTANT a staffer compares against
 * their own "today" — so `DecisionOutcomeBanner` renders it through `<LocalDate>`, in the
 * viewer's zone. Neither reads a local getter server-side, which is the property F15 pinned.
 *
 * Server Component: presentational only, no I/O, no interactivity.
 *
 * BAL-593 — `selfRatings` overlays the expert's own rating beside Balo's effective one (AC 4),
 * and `skillsLocked` shows a "Locked for the expert" pill on Product expertise, Ratings and
 * Certifications (Decision 4). Neither prop changes what is WRITABLE here — this stays a
 * read-only Server Component; the edit workspace is a separate client island.
 */

interface ApplicationSectionsProps {
  readonly application: ApplicationWithRelations;
  readonly productsByCategory: readonly ProductsByCategory[];
  readonly supportTypes: readonly SupportType[];
  readonly certificationsByCategory: readonly CertificationsByCategory[];
  readonly selfRatings: readonly StaffSelfRating[];
  readonly skillsLocked: boolean;
}

function SectionHeading({
  icon: Icon,
  children,
  aside,
}: Readonly<{
  icon: typeof Briefcase;
  children: React.ReactNode;
  aside?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <div className="bg-muted flex size-[26px] items-center justify-center rounded-[7px]">
          <Icon className="text-muted-foreground size-3.5" aria-hidden="true" />
        </div>
        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
          {children}
        </p>
      </div>
      {aside}
    </div>
  );
}

/** Decision 4 — why these three sections can only change on the staff edit workspace. */
function LockedPill(): React.JSX.Element {
  return (
    <span
      title="Approval locked this section. Only Balo can change it, here."
      className="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
    >
      <Lock className="size-3" aria-hidden="true" />
      {/* pending-MJ */}
      Locked for the expert
    </span>
  );
}

/** One rating cell: Balo's effective value, beside the expert's own (`null` means Balo added
 *  the cell — there was never a self-rating to show). */
interface RatingCell {
  supportType: SupportType;
  balo: number;
  self: number | null;
}

function buildSelfRatingMap(selfRatings: readonly StaffSelfRating[]): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const r of selfRatings) {
    map.set(`${r.productId}:${r.supportTypeId}`, r.selfProficiency);
  }
  return map;
}

function buildRatingCells(
  productId: string,
  ratings: Map<string, number>,
  supportTypes: readonly SupportType[],
  selfRatingMap: Map<string, number | null>
): RatingCell[] {
  return supportTypes.map((supportType) => ({
    supportType,
    balo: ratings.get(supportType.slug) ?? 0,
    self: selfRatingMap.get(`${productId}:${supportType.id}`) ?? null,
  }));
}

export function ApplicationSections({
  application,
  productsByCategory,
  supportTypes,
  certificationsByCategory,
  selfRatings,
  skillsLocked,
}: Readonly<ApplicationSectionsProps>): React.JSX.Element {
  const { profile, competencies, certifications, languages, industries } = application;

  const productCategoryMap = buildProductCategoryMap(productsByCategory);
  const { productNamesByCategory, uniqueProductIds } = buildProductNamesByCategory(
    competencies,
    productCategoryMap
  );
  const assessmentMap = buildAssessmentMap(competencies);
  const certCategoryMap = buildCertCategoryMap(certificationsByCategory);
  const distinctions = buildDistinctions(profile);
  const selfRatingMap = buildSelfRatingMap(selfRatings);
  const ratingsByProduct = [...assessmentMap.entries()].map(([productId, { name, ratings }]) => ({
    productId,
    name,
    cells: buildRatingCells(productId, ratings, supportTypes, selfRatingMap),
  }));
  const anyAdjusted = ratingsByProduct.some(({ cells }) =>
    cells.some((cell) => cell.self !== null && cell.self !== cell.balo)
  );

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
          <SectionHeading icon={Sparkles} aside={skillsLocked ? <LockedPill /> : null}>
            Product expertise
          </SectionHeading>
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

      {/* Ratings — BAL-593 renamed from "Self-assessment" now that Balo's effective rating and
          the expert's own self-rating can differ (AC 4). */}
      {ratingsByProduct.length > 0 && (
        <section>
          <SectionHeading icon={Sparkles} aside={skillsLocked ? <LockedPill /> : null}>
            Ratings (0–10)
          </SectionHeading>
          {anyAdjusted && (
            <p className="text-muted-foreground -mt-1 mb-3 text-xs leading-relaxed">
              {/* pending-MJ */}
              &ldquo;Self 8 → 5&rdquo; means the expert rated themselves 8 and Balo set 5. Search
              and the public profile use Balo&rsquo;s rating.
            </p>
          )}
          <div className="flex flex-col gap-3">
            {ratingsByProduct.map(({ productId, name, cells }) => {
              const staffAdded = cells.every((cell) => cell.self === null);
              const adjustedCount = cells.filter(
                (cell) => cell.self !== null && cell.self !== cell.balo
              ).length;
              return (
                <div key={productId} className="border-border bg-card rounded-xl border p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <p className="text-foreground flex-1 text-sm font-semibold">{name}</p>
                    {staffAdded && (
                      <span className="bg-primary/10 text-primary rounded-full px-2.5 py-0.5 text-[11px] font-semibold">
                        {/* pending-MJ */}
                        Added by Balo
                      </span>
                    )}
                    {!staffAdded && adjustedCount > 0 && (
                      <span className="bg-warning/10 text-warning rounded-full px-2.5 py-0.5 text-[11px] font-semibold">
                        {/* pending-MJ */}
                        {adjustedCount} adjusted
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                    {cells.map(({ supportType, balo, self }) => (
                      <div
                        key={supportType.id}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="text-muted-foreground">{supportType.name}</span>
                        <span className="whitespace-nowrap">
                          {self !== null && self !== balo && (
                            <span className="text-warning mr-1.5 text-xs font-medium">
                              Self {self} →
                            </span>
                          )}
                          <span className="text-foreground font-mono font-semibold tabular-nums">
                            {balo}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Certifications */}
      {(certifications.length > 0 || profile.trailheadUrl !== null) && (
        <section>
          <SectionHeading icon={Award} aside={skillsLocked ? <LockedPill /> : null}>
            Certifications
          </SectionHeading>
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
    </div>
  );
}

/**
 * Work history — ROLE, COMPANY, **TENURE** AND **RESPONSIBILITIES** (web-review fix round, W2).
 * The first two were all this section rendered, and the missing pair is exactly what a reviewer
 * needs in order to choose the `experience_depth` decline reason: "Solutions Architect at Acme"
 * says nothing about whether it lasted four months or six years, or what the person actually
 * did. The applicant's own review page has rendered both since day one, and the ticket requires
 * this page show the application AS THE APPLICANT WROTE IT.
 *
 * No read widening was needed: `findApplicationForStaffReview`'s `workHistory` relation carries
 * no `columns:` allow-list, so `started_at`, `ended_at` and `responsibilities` are already on the
 * row, and all three are the applicant's own words.
 *
 * BAL-593 — EXPORTED so the review page can render it once, outside `ApplicationSections`, and
 * reuse the same node for both read mode and the staff edit workspace (work history is not part
 * of the staff edit surface at all, so the workspace dims this same render while editing rather
 * than rendering its own copy).
 */
interface WorkHistorySectionProps {
  readonly entries: ApplicationWithRelations['workHistory'];
}

export function WorkHistorySection({
  entries,
}: Readonly<WorkHistorySectionProps>): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <section>
      <SectionHeading icon={Briefcase}>Work history</SectionHeading>
      <div className="flex flex-col gap-3">
        {entries.map((entry) => (
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
            <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
              <Clock className="size-3" aria-hidden="true" />
              {formatPeriod(entry.startedAt, entry.endedAt, entry.isCurrent)}
            </p>
            <ResponsibilitiesBlock value={entry.responsibilities} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A work-history entry's responsibilities as the applicant formatted them. Rich text since the
 * field became an editor; legacy plain text arrives as escaped paragraphs. `RichText` re-sanitises
 * before it injects.
 */
function ResponsibilitiesBlock({
  value,
}: Readonly<{ value: string | null }>): React.JSX.Element | null {
  const html = sanitizeResponsibilitiesHtml(value);
  if (html === '') return null;
  return (
    <RichText
      html={html}
      className="text-foreground border-border mt-3 border-t pt-3 text-[13px] [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
    />
  );
}
