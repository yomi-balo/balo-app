import { Search, Check } from 'lucide-react';
import { RevealGroup } from '@/components/marketing/motion/reveal-group';
import { deriveInitials } from '@/lib/search/expert-card-mapper';
import { cn } from '@/lib/utils';
import { STEPS, HOW_IT_WORKS_MATCH_ROWS } from './copy';

/** Step 1's illustrative product fragment — a real search bar, not real data. */
function FragSearch(): React.JSX.Element {
  return (
    <>
      <div className="mk-frag-search">
        <Search size={13} aria-hidden="true" />
        <span>Lead assignment Flow fails on update…</span>
      </div>
      <span className="mk-frag-tag">Sales Cloud · Flow</span>
    </>
  );
}

/** Step 2's fragment — `HOW_IT_WORKS_MATCH_ROWS` (`copy.ts`), the two illustrative candidates. */
function FragMatch(): React.JSX.Element {
  return (
    <>
      {HOW_IT_WORKS_MATCH_ROWS.map((row) => (
        <div className={cn('mk-frag-row', row.selected && 'on')} key={row.id}>
          <div className="mk-frag-av" style={{ background: 'var(--grad)' }}>
            {deriveInitials(row.name)}
          </div>
          <div>
            <div className="mk-frag-name">{row.name}</div>
            <div className="mk-frag-meta">{row.meta}</div>
          </div>
          {row.selected && (
            <span className="mk-frag-check">
              <Check size={14} aria-hidden="true" />
            </span>
          )}
        </div>
      ))}
    </>
  );
}

/** Step 3's fragment — a static slot/duration picker. */
function FragBook(): React.JSX.Element {
  return (
    <>
      <div className="mk-frag-day">Today</div>
      <div className="mk-frag-slots">
        <span className="on">2:30 PM</span>
        <span>3:00 PM</span>
        <span>4:15 PM</span>
      </div>
      <div className="mk-frag-day">Duration</div>
      <div className="mk-frag-slots">
        <span className="on">30 min</span>
        <span>45 min</span>
        <span>60 min</span>
      </div>
    </>
  );
}

/**
 * Step 4's fragment. `23 min` / `A$42.55` are the plan §13.5-sanctioned illustrative receipt
 * figures — a worked example inside a mock fragment, not a promise about any given session.
 */
function FragDone(): React.JSX.Element {
  return (
    <>
      <div className="mk-frag-line">
        <span>Session ended</span>
        <span className="mk-mono">23 min</span>
      </div>
      <div className="mk-frag-line">
        <span>Total</span>
        <span className="mk-mono">A$42.55</span>
      </div>
      <span className="mk-frag-paid">Paid · fee included</span>
    </>
  );
}

const STEP_FRAGMENTS = [FragSearch, FragMatch, FragBook, FragDone] as const;

/**
 * BAL-493 §3 — "From stuck to fixed in four steps." Fully static server component; the 4
 * product fragments are structural markup illustrating the flow, not copy — `copy.ts`'s
 * `STEPS` docblock states this explicitly ("the accompanying product fragments render inline
 * in `how-it-works-section.tsx`").
 */
export function HowItWorksSection(): React.JSX.Element {
  return (
    <section className="mk-section" id="how-it-works">
      <RevealGroup className="mk-wrap">
        <div className="mk-head">
          <div>
            <div className="mk-eyebrow mk-reveal">How it works</div>
            <h2 className="mk-h2 mk-reveal" style={{ '--i': 1 } as React.CSSProperties}>
              From stuck to fixed in four steps.
            </h2>
            <p className="mk-sub mk-reveal" style={{ '--i': 2 } as React.CSSProperties}>
              For a consultation there is no discovery call and nothing to wait on. Describe the
              problem and you can be on a screen-share today.
            </p>
          </div>
        </div>
        <div className="mk-steps">
          <div className="mk-steps-track" />
          <div className="mk-steps-progress" />
          {STEPS.map((step, index) => {
            const StepFragment = STEP_FRAGMENTS[index];
            return (
              <div
                className="mk-step mk-reveal"
                style={{ '--i': index + 2 } as React.CSSProperties}
                key={step.n}
              >
                <div className="mk-step-dot" />
                <div className="mk-step-num">{step.n}</div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                <div className="mk-frag">{StepFragment ? <StepFragment /> : null}</div>
              </div>
            );
          })}
        </div>
      </RevealGroup>
    </section>
  );
}
