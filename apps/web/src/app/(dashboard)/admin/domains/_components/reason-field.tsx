import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface ReasonFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  autoFocus?: boolean;
  disabled?: boolean;
}

/** The audit-log reason every staff domain change requires. Hint and error are wired by id. */
export function ReasonField({
  id,
  value,
  onChange,
  error,
  autoFocus,
  disabled,
}: Readonly<ReasonFieldProps>): React.JSX.Element {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void =>
    onChange(event.target.value);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-xs font-semibold">
        Reason
      </Label>
      <Textarea
        id={id}
        rows={2}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-required="true"
        onChange={handleChange}
        placeholder="Who asked, and how you confirmed they own it"
        aria-invalid={error !== null}
        aria-describedby={error === null ? hintId : `${hintId} ${errorId}`}
        className={cn('resize-y', error !== null && 'border-destructive')}
      />
      <p id={hintId} className="text-muted-foreground text-xs">
        Saved to the audit log with your name. Customers never see it.
      </p>
      {error !== null && (
        <p id={errorId} role="alert" className="text-destructive text-xs font-medium">
          {error}
        </p>
      )}
    </div>
  );
}
