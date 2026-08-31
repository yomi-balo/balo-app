import { Check } from 'lucide-react';
import { RevealGroup } from '@/components/marketing/motion/reveal-group';
import { deriveInitials } from '@/lib/search/expert-card-mapper';
import { PresetParallax } from './preset-parallax';
import { PRICE_POINTS, PRICE_NOS, RECEIPT } from './copy';

/**
 * BAL-493 §3 / §13.5 — "One all-in rate. No surprises." Server component. `RECEIPT` (`copy.ts`)
 * is the page's one illustrative worked example — a real session shape, not a promise about
 * what any given visitor will pay. `PRICE_POINTS[0].title` ("Service fee included") is the ONLY
 * sanctioned fee-language string on the whole page (AC-8).
 *
 * The receipt card is wrapped in `<Parallax>` as a DIRECT CHILD of `.mk-receipt-wrap` (the
 * p4a handoff contract: `compute` measures the wrapper's PARENT, so `.mk-receipt-wrap` — not
 * the receipt card itself — is what `FX_RECEIPT` scrolls against).
 */
export function PricingSection(): React.JSX.Element {
  return (
    <section className="mk-section" id="pricing">
      <RevealGroup className="mk-wrap mk-price">
        <div>
          <div className="mk-eyebrow mk-reveal">Pricing</div>
          <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 } as React.CSSProperties}>
            One all-in rate. No surprises.
          </h2>
          <p className="mk-sub mk-reveal" style={{ '--i': 2 } as React.CSSProperties}>
            Every expert sets their own per-minute rate. The number on their profile is the number
            you pay.
          </p>
          <ul className="mk-price-list">
            {PRICE_POINTS.map((point, index) => (
              <li
                className="mk-reveal"
                style={{ '--i': index + 3 } as React.CSSProperties}
                key={point.title}
              >
                <span className="mk-tick">
                  <Check size={12} aria-hidden="true" />
                </span>
                <div>
                  <strong>{point.title}</strong>
                  {point.body}
                </div>
              </li>
            ))}
          </ul>
          <div className="mk-price-nos mk-reveal" style={{ '--i': 6 } as React.CSSProperties}>
            {PRICE_NOS.map((no) => (
              <span className="mk-no" key={no}>
                {no}
              </span>
            ))}
          </div>
        </div>

        <div className="mk-receipt-wrap mk-reveal" style={{ '--i': 2 } as React.CSSProperties}>
          <div className="mk-receipt-glow" aria-hidden="true" />
          <PresetParallax preset="receipt" className="mk-receipt">
            <div className="mk-rc-head">
              <span className="mk-rc-kicker">Session receipt</span>
              <span className="mk-rc-paid">Paid</span>
            </div>
            <div className="mk-rc-who">
              <div className="mk-avatar" style={{ background: 'var(--grad)', borderRadius: '50%' }}>
                {deriveInitials(RECEIPT.expertName)}
              </div>
              <div>
                <strong>{RECEIPT.expertName}</strong>
                <span>{RECEIPT.sessionLabel}</span>
              </div>
            </div>
            <div className="mk-rc-row">
              <span>Duration</span>
              <span className="mk-mono">{RECEIPT.durationMinutes} min</span>
            </div>
            <div className="mk-rc-row">
              <span>Rate</span>
              <span className="mk-mono">{RECEIPT.ratePerMinute}</span>
            </div>
            <div className="mk-rc-row">
              <span>Service fee</span>
              <span className="mk-mono">Included</span>
            </div>
            <div className="mk-rc-total">
              <span>Total</span>
              <span className="mk-rc-total-val">{RECEIPT.total}</span>
            </div>
            <div className="mk-rc-foot">{RECEIPT.footnote}</div>
          </PresetParallax>
        </div>
      </RevealGroup>
    </section>
  );
}
