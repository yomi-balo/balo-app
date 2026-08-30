import { ArrowRight } from 'lucide-react';
import type { ExpertCardData } from '@/components/expert/expert-card.types';
import { RevealGroup } from '@/components/marketing/motion/reveal-group';
import { MARKETING_ICONS } from './icons';
import { CtaLink } from './cta-link';
import { SpotlightGrid } from './spotlight-grid';
import { VERTICAL, VETTING_CHECKS } from './copy';

interface ExpertsSectionProps {
  /** 0..`FEATURED_EXPERT_LIMIT` (3) — `loadHomeData()`'s `spotlight`. */
  readonly experts: readonly ExpertCardData[];
  /** `null` ⇒ the live count is unknown (search fetch failed) — degrade the 0-card sub-line. */
  readonly expertTotal: number | null;
}

/** §8.4 — `.mk-experts` is the base grid; `--2`/`--1` are ADDITIVE modifiers, not replacements
 * (neither sets `display: grid` on its own). */
function gridClassName(count: number): string {
  if (count === 2) return 'mk-experts mk-experts--2';
  if (count === 1) return 'mk-experts mk-experts--1';
  return 'mk-experts';
}

/**
 * BAL-493 §3 / §8.4 — "A few of the top 1%." Server component. The heading, sub-copy and the
 * 4-item vetting strip are ALWAYS rendered regardless of spotlight count — this section never
 * disappears and is never framed by absence (CLAUDE.md + `balo-ui-skill`). The "Browse all
 * experts" head-link renders in every state so the section always offers the forward action.
 *
 * 3/2/1 cards render through `<SpotlightGrid>` (the canonical `ExpertCard`, unmodified). The
 * 0-card state — the SHIPPED DEFAULT, since `FEATURED_EXPERT_USERNAMES` ships empty (D2) — is
 * the `.mk-xc-invite` panel: never "No featured experts yet," always a real invitation to
 * `/experts`, with an honest sub-line when `expertTotal` is known.
 */
export function ExpertsSection({
  experts,
  expertTotal,
}: Readonly<ExpertsSectionProps>): React.JSX.Element {
  const count = experts.length;

  return (
    <section className="mk-section mk-mist" id="experts">
      <RevealGroup className="mk-wrap">
        <div className="mk-head">
          <div>
            <div className="mk-eyebrow mk-reveal">Meet the experts</div>
            <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 } as React.CSSProperties}>
              A few of the top 1%.
            </h2>
            <p className="mk-sub mk-reveal" style={{ '--i': 2 } as React.CSSProperties}>
              Every expert has passed four checks before they can take a booking. Ratings stay on
              their profile for as long as they are on Balo.
            </p>
          </div>
          <CtaLink
            placement="experts"
            label="Browse all experts"
            href="/experts"
            className="mk-head-link mk-reveal"
          >
            Browse all experts
            <ArrowRight size={16} aria-hidden="true" />
          </CtaLink>
        </div>

        <div className="mk-vet">
          {VETTING_CHECKS.map((check, index) => {
            const Icon = MARKETING_ICONS[check.icon];
            return (
              <div
                className="mk-vet-item mk-reveal"
                style={{ '--i': index + 2 } as React.CSSProperties}
                key={check.title}
              >
                <span className="mk-vet-check">
                  <Icon size={12} aria-hidden="true" />
                </span>
                <div>
                  <strong>{check.title}</strong>
                  <span>{check.body}</span>
                </div>
              </div>
            );
          })}
        </div>

        {count === 0 ? (
          <div className="mk-reveal">
            <div className="mk-xc-invite">
              <p>
                {expertTotal === null
                  ? `New ${VERTICAL.name} experts join Balo every week.`
                  : `${expertTotal} ${VERTICAL.name} experts are on Balo right now.`}
              </p>
              <CtaLink
                placement="experts"
                label="Browse every vetted expert"
                href="/experts"
                className="mk-btn mk-btn-grad"
              >
                Browse every vetted expert
                <ArrowRight size={16} aria-hidden="true" />
              </CtaLink>
            </div>
          </div>
        ) : (
          <SpotlightGrid experts={experts} className={gridClassName(count)} />
        )}
      </RevealGroup>
    </section>
  );
}
