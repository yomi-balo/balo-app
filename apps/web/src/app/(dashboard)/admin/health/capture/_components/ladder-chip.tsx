import type {
  RecapLadderState,
  RecordingLadderState,
  TranscriptionLadderState,
} from '@balo/shared/capture-health';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { LADDER_META, TONE, type CaptureHealthLadderMeta } from './ladder-tone';
import type { CaptureHealthLadderView } from '../_lib/capture-health-view';

/**
 * BAL-550 — one ladder chip (design reference `LadderChip`, `admin-home.jsx:1882`). Pure — no
 * hooks — so the server-rendered pinned band can use it directly, exactly like `HealthRow`.
 *
 * ⚠⚠ THE PROPS ARE A DISCRIMINATED UNION, AND THE LOOKUP IS NOT CAST. `ladder` and `state` are
 * CORRELATED: `rec` may only ever carry a `RecordingLadderState`, and so on. That correlation
 * is what makes `LADDER_META.rec[state.state]` total without a runtime fallback — a state this
 * table does not map is UNREPRESENTABLE rather than rendered as a silent `—`. Widening the
 * lookup back to `Record<string, …>` + a fallback would restore the exact failure mode the
 * fifth recording state (`capturing`) was added to catch, so do not re-introduce one.
 */
type LadderChipProps =
  | { readonly ladder: 'rec'; readonly state: CaptureHealthLadderView<RecordingLadderState> }
  | { readonly ladder: 'tx'; readonly state: CaptureHealthLadderView<TranscriptionLadderState> }
  | { readonly ladder: 'recap'; readonly state: CaptureHealthLadderView<RecapLadderState> };

function metaFor(props: LadderChipProps): CaptureHealthLadderMeta {
  if (props.ladder === 'rec') return LADDER_META.rec[props.state.state];
  if (props.ladder === 'tx') return LADDER_META.tx[props.state.state];
  return LADDER_META.recap[props.state.state];
}

export function LadderChip(props: Readonly<LadderChipProps>): React.JSX.Element {
  const { state } = props;
  const meta = metaFor(props);
  const tone = TONE[meta.tone];

  return (
    <div className="min-w-0">
      <Badge
        variant="outline"
        className={cn(
          'gap-1 border font-semibold',
          tone.text,
          tone.bg,
          tone.border,
          meta.pulse === true && 'animate-pulse'
        )}
      >
        {meta.label}
        {state.stage !== undefined && (
          <span className="font-medium opacity-85">· {state.stage}</span>
        )}
      </Badge>
      {state.note !== undefined && (
        <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">{state.note}</p>
      )}
    </div>
  );
}
