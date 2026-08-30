import { ArrowRight } from 'lucide-react';
import { RevealGroup } from '@/components/marketing/motion/reveal-group';
import { MARKETING_ICONS } from './icons';
import { CtaLink } from './cta-link';
import { PresetParallax } from './preset-parallax';
import { PERKS } from './copy';

/**
 * BAL-493 §3 / §13.5 — "Built for the experts, too." The one dark moment on the page (Table
 * A/B row 7, `.mk-xband` on `--night`). Server component.
 *
 * ⚠⚠ NO fee/margin/cut/commission/earnings/payout language anywhere in this file or in
 * `PERKS` (`copy.ts`) — AC-8's strictest scan targets this section specifically.
 *
 * The two glows are `<Parallax>`-managed and therefore rendered as DIRECT children of
 * `<section className="mk-xband">` (not wrapped in an extra decorative container), so
 * `compute` measures the section itself — the p4a handoff contract ("place `<Parallax>` as a
 * direct child of the element you want measured").
 *
 * All three decorative layers are `aria-hidden`. `.mk-xband-grid` (the dot pattern) needs no
 * `<Parallax>` and carries the attribute directly; the two glows pass it through the wrapper's
 * `ariaHidden` prop (added in fix round 1 — `Parallax` previously took only
 * `compute`/`className`/`children`, which left two bare `<div>`s exposed to assistive tech
 * three lines from a sibling that was correctly hidden). Consistency is the point: an empty
 * decorative div is cheap to skip but should not be the ONE thing on the band a screen reader
 * still walks. Matches `hero-section.tsx`'s decorative-background pattern.
 */
export function ExpertBandSection(): React.JSX.Element {
  return (
    <section className="mk-xband" id="for-experts">
      <PresetParallax preset="glow-a" className="mk-xband-glow" ariaHidden>
        {null}
      </PresetParallax>
      <PresetParallax preset="glow-b" className="mk-xband-glow mk-xband-glow2" ariaHidden>
        {null}
      </PresetParallax>
      <div className="mk-xband-grid" aria-hidden="true" />
      <RevealGroup className="mk-wrap mk-xband-inner">
        <div>
          <div className="mk-eyebrow mk-reveal">For experts</div>
          <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 } as React.CSSProperties}>
            Built for the experts, too.
          </h2>
          <p className="mk-sub mk-reveal" style={{ '--i': 2 } as React.CSSProperties}>
            Keep the work you love and lose the admin. Set your rate, open the hours you want, and
            let pre-qualified clients come to you.
          </p>
          <div className="mk-xband-ctas mk-reveal" style={{ '--i': 3 } as React.CSSProperties}>
            <CtaLink
              placement="band"
              label="Apply to join"
              href="/expert/apply"
              className="mk-btn mk-btn-lg mk-btn-white"
            >
              Apply to join
              <ArrowRight size={16} aria-hidden="true" />
            </CtaLink>
            <CtaLink
              placement="band"
              label="How vetting works"
              href="/#experts"
              className="mk-btn mk-btn-lg mk-btn-outline-light"
            >
              How vetting works
            </CtaLink>
          </div>
        </div>
        <div className="mk-perks">
          {PERKS.map((perk, index) => {
            const Icon = MARKETING_ICONS[perk.icon];
            return (
              <div
                className="mk-reveal"
                style={{ '--i': index + 2 } as React.CSSProperties}
                key={perk.title}
              >
                <div className="mk-perk">
                  <div className="mk-perk-icon">
                    <Icon size={18} aria-hidden="true" />
                  </div>
                  <div>
                    <strong>{perk.title}</strong>
                    <span>{perk.body}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </RevealGroup>
    </section>
  );
}
