import { ArrowRight } from 'lucide-react';
import { RevealGroup } from '@/components/marketing/motion/reveal-group';
import { MARKETING_ICONS } from './icons';
import { CtaLink } from './cta-link';
import { WAYS } from './copy';

/**
 * BAL-493 §3 — "Three ways to get it done": Consultations · Projects · Packages. Server
 * component; the only client surface is the 3 `<CtaLink>` islands (placement `'ways'`).
 *
 * ⚠ DEVIATION from the design reference: every card's link routes to `/experts`, not a
 * per-card destination. The reference's own markup links all three to `#experts` too (an
 * in-page anchor to the same spotlight section) — there is no public project-posting flow nor
 * a public package catalogue to link to (plan §13.2, "ship only links that resolve"; the
 * `(dashboard)/projects` route is authenticated app surface, not a marketing destination).
 * `label` still carries each card's own `linkLabel` text, so `marketing_home_cta_clicked`
 * distinguishes which card drove the click even though the href is shared.
 *
 * ⚠ AND BECAUSE THE HREF IS SHARED, THE LABELS MUST NOT PROMISE OTHERWISE. The first build
 * shipped "Post a project" and "Browse packages" on links that land on the generic expert
 * grid — an intake form and a catalogue that do not exist. `copy.ts`'s `WAYS[].linkLabel` now
 * describes what actually happens (finding an expert); do not reintroduce a label that names
 * a destination this href cannot reach.
 */
export function WaysSection(): React.JSX.Element {
  return (
    <section className="mk-section mk-mist" id="ways">
      <RevealGroup className="mk-wrap">
        <div className="mk-head">
          <div>
            <div className="mk-eyebrow mk-reveal">Ways to work</div>
            <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 } as React.CSSProperties}>
              Three ways to get it done.
            </h2>
            <p className="mk-sub mk-reveal" style={{ '--i': 2 } as React.CSSProperties}>
              Every expert on Balo works all three ways. Start with whichever fits the problem in
              front of you.
            </p>
          </div>
        </div>
        <div className="mk-ways">
          {WAYS.map((way, index) => {
            const Icon = MARKETING_ICONS[way.icon];
            return (
              <div
                className="mk-reveal"
                style={{ '--i': index + 2 } as React.CSSProperties}
                key={way.title}
              >
                <article className="mk-way">
                  <div className="mk-way-icon">
                    <Icon size={20} aria-hidden="true" />
                  </div>
                  <div className="mk-way-kicker">{way.kicker}</div>
                  <h3>{way.title}</h3>
                  <p>{way.body}</p>
                  <div className="mk-way-foot">
                    <span className="mk-way-tag">{way.tag}</span>
                    <CtaLink
                      placement="ways"
                      label={way.linkLabel}
                      href="/experts"
                      className="mk-way-link"
                    >
                      {way.linkLabel}
                      <ArrowRight size={14} aria-hidden="true" />
                    </CtaLink>
                  </div>
                </article>
              </div>
            );
          })}
        </div>
      </RevealGroup>
    </section>
  );
}
