'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { track, HELP_EVENTS, HELP_FEEDBACK_COMMENT_MAX } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import { toFeedbackPayload } from './feedback-payload';

type FeedbackState = 'ask' | 'no' | 'thanks' | 'sent';

const BUTTON_CLASS =
  'bg-card text-foreground border-line hover:bg-accent focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-[10px] border px-3.5 py-2 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none';

/** "Did this guide help?" — one `help_feedback_submitted` event per visit, on the final choice. */
export function GuideFeedback({ slug }: Readonly<{ slug: string }>): React.JSX.Element {
  const [state, setState] = useState<FeedbackState>('ask');
  const [note, setNote] = useState('');
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state === 'no') noteRef.current?.focus();
  }, [state]);

  const handleYes = useCallback(() => {
    track(HELP_EVENTS.FEEDBACK_SUBMITTED, toFeedbackPayload(slug, true));
    setState('thanks');
  }, [slug]);

  const handleNo = useCallback(() => setState('no'), []);

  const submitNo = useCallback(
    (text: string) => {
      const payload = toFeedbackPayload(slug, false, text);
      track(HELP_EVENTS.FEEDBACK_SUBMITTED, payload);
      setState(payload.has_comment ? 'sent' : 'thanks');
    },
    [slug]
  );

  const handleSend = useCallback(() => submitNo(note), [submitNo, note]);
  const handleSkip = useCallback(() => submitNo(''), [submitNo]);

  return (
    <div className="border-line mt-14 border-t pt-7">
      {state === 'ask' && (
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-3.5 border-0 p-0">
          <legend className="sr-only">Did this guide help?</legend>
          <span aria-hidden="true" className="text-foreground text-[15px] font-semibold">
            Did this guide help?
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={handleYes} className={BUTTON_CLASS}>
              <ThumbsUp aria-hidden="true" className="size-[15px]" />
              Yes
            </button>
            <button type="button" onClick={handleNo} className={BUTTON_CLASS}>
              <ThumbsDown aria-hidden="true" className="size-[15px]" />
              No
            </button>
          </div>
        </fieldset>
      )}
      {state === 'no' && (
        <div>
          <label htmlFor="help-feedback" className="text-foreground text-[15px] font-semibold">
            What were you trying to do?
          </label>
          <p className="text-muted-foreground mt-1 mb-2.5 text-sm">
            Optional. It goes to the team that writes these guides.
          </p>
          <textarea
            id="help-feedback"
            ref={noteRef}
            rows={3}
            maxLength={HELP_FEEDBACK_COMMENT_MAX}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="bg-card text-foreground border-line focus-visible:ring-ring w-full resize-y rounded-[10px] border px-3 py-2.5 text-[15px] outline-none focus-visible:ring-2"
          />
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={handleSend}
              className={cn(
                BUTTON_CLASS,
                'bg-primary text-primary-foreground hover:bg-primary/90 border-transparent'
              )}
            >
              Send
            </button>
            <button type="button" onClick={handleSkip} className={BUTTON_CLASS}>
              Skip
            </button>
          </div>
        </div>
      )}
      <div role="status" aria-live="polite">
        {state === 'thanks' && (
          <p className="text-foreground m-0 text-[15px] font-semibold">
            Thanks for letting us know.
          </p>
        )}
        {state === 'sent' && (
          <p className="text-foreground m-0 text-[15px] font-semibold">
            Thanks. Your note will help us fix this guide.
          </p>
        )}
      </div>
    </div>
  );
}
