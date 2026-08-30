import { StarRow } from '@/components/expert/profile/rating-stars';
import { RevealGroup } from '@/components/marketing/motion/reveal-group';
import { deriveInitials } from '@/lib/search/expert-card-mapper';
import { QUOTES } from './copy';

/**
 * BAL-493 §3 — "Small questions, big builds, same place." Server component.
 *
 * TODO(MJ): `QUOTES` (`copy.ts`) are placeholder testimonials pending real, attributable
 * quotes.
 *
 * Each card's 5-star row is DECORATIVE — a fixed rating on a marketing quote, not a computed
 * review aggregate — so it reuses `StarRow` (`expert/profile/rating-stars.tsx`, a ready,
 * token-driven primitive not yet mounted elsewhere) rather than inventing a new star icon row,
 * and is `aria-hidden` since the quote text itself carries the accessible content.
 */
export function TestimonialsSection(): React.JSX.Element {
  return (
    <section className="mk-section mk-mist" id="testimonials">
      <RevealGroup className="mk-wrap">
        <div className="mk-head">
          <div>
            <div className="mk-eyebrow mk-reveal">From clients</div>
            <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 } as React.CSSProperties}>
              Small questions, big builds, same place.
            </h2>
          </div>
        </div>
        <div className="mk-quotes">
          {QUOTES.map((quote, index) => (
            <div
              className="mk-reveal"
              style={{ '--i': index + 2 } as React.CSSProperties}
              key={quote.name}
            >
              <figure className="mk-quote">
                <div className="mk-stars" aria-hidden="true">
                  <StarRow rating={5} size={13} />
                </div>
                <blockquote style={{ margin: 0, flex: 1 }}>
                  <p>“{quote.quote}”</p>
                </blockquote>
                <figcaption className="mk-quote-who">
                  <div
                    className="mk-avatar"
                    style={{
                      background: 'var(--grad)',
                      width: 38,
                      height: 38,
                      fontSize: 12,
                      borderRadius: '50%',
                    }}
                  >
                    {deriveInitials(quote.name)}
                  </div>
                  <div>
                    <div className="mk-quote-name">{quote.name}</div>
                    <div className="mk-quote-role">{quote.role}</div>
                  </div>
                </figcaption>
                <div className="mk-quote-ctx">{quote.context}</div>
              </figure>
            </div>
          ))}
        </div>
      </RevealGroup>
    </section>
  );
}
