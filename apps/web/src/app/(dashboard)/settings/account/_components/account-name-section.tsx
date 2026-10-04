'use client';

import { useCallback, useId, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateNameAction } from '@/lib/auth/actions/update-name';
import { PERSON_NAME_MAX, personNameSchema } from '@/lib/auth/name-schema';

const SAVE_FAILURE_MESSAGE = "We couldn't save your name — please try again.";
const SAVE_SUCCESS_MESSAGE = 'Name updated.';

type NameErrors = Partial<Record<'firstName' | 'lastName', string>>;

/**
 * "Your name" — the person's first and last name, editable by every signed-in user. Card shell
 * and idiom from `billing-email-section.tsx`: dirty-gated Save, Sonner toast, `router.refresh()`
 * so the sidebar and user menu pick up the name the action re-sealed into the session.
 *
 * Validated on Save against `personNameSchema` — the same rule `updateNameAction` enforces — and
 * a field's message clears as soon as it is edited. On failure the draft is never reverted, so
 * nothing has to be re-typed.
 */
export function AccountNameSection({
  initialFirstName,
  initialLastName,
}: Readonly<{ initialFirstName: string; initialLastName: string }>): React.JSX.Element {
  const router = useRouter();
  const firstNameId = useId();
  const lastNameId = useId();
  const [saved, setSaved] = useState({ firstName: initialFirstName, lastName: initialLastName });
  const [draft, setDraft] = useState(saved);
  const [errors, setErrors] = useState<NameErrors>({});
  const [pending, setPending] = useState(false);

  const isDirty =
    draft.firstName.trim() !== saved.firstName || draft.lastName.trim() !== saved.lastName;

  const handleChange = useCallback(
    (field: 'firstName' | 'lastName') =>
      (event: ChangeEvent<HTMLInputElement>): void => {
        const { value } = event.target;
        setDraft((current) => ({ ...current, [field]: value }));
        setErrors((current) => ({ ...current, [field]: undefined }));
      },
    []
  );

  const runSave = useCallback(async (): Promise<void> => {
    const parsed = personNameSchema.safeParse(draft);
    if (!parsed.success) {
      const next: NameErrors = {};
      for (const issue of parsed.error.issues) {
        const [field] = issue.path;
        if ((field === 'firstName' || field === 'lastName') && next[field] === undefined) {
          next[field] = issue.message;
        }
      }
      setErrors(next);
      return;
    }

    setPending(true);
    try {
      const result = await updateNameAction(parsed.data);
      if (!result.success) {
        toast.error(result.error ?? SAVE_FAILURE_MESSAGE);
        return;
      }
      setSaved(parsed.data);
      setDraft(parsed.data);
      toast.success(SAVE_SUCCESS_MESSAGE);
      router.refresh();
    } catch {
      toast.error(SAVE_FAILURE_MESSAGE);
    } finally {
      setPending(false);
    }
  }, [draft, router]);

  const handleSaveClick = useCallback((): void => {
    runSave().catch(() => undefined);
  }, [runSave]);

  return (
    <div className="border-border bg-card rounded-2xl border p-6 shadow-sm">
      <h2 className="text-foreground text-sm font-semibold">Your name</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        How you appear to experts, clients and your team across Balo.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NameInput
          id={firstNameId}
          label="First name"
          autoComplete="given-name"
          value={draft.firstName}
          error={errors.firstName}
          onChange={handleChange('firstName')}
        />
        <NameInput
          id={lastNameId}
          label="Last name"
          autoComplete="family-name"
          value={draft.lastName}
          error={errors.lastName}
          onChange={handleChange('lastName')}
        />
      </div>

      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          onClick={handleSaveClick}
          disabled={!isDirty || pending}
          aria-label="Save name"
          className="active:scale-[0.98] motion-reduce:active:scale-100"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save changes'
          )}
        </Button>
      </div>
    </div>
  );
}

function NameInput({
  id,
  label,
  autoComplete,
  value,
  error,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  autoComplete: 'given-name' | 'family-name';
  value: string;
  error: string | undefined;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}>): React.JSX.Element {
  const errorId = `${id}-error`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        maxLength={PERSON_NAME_MAX}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        className="mt-1.5"
      />
      {error !== undefined && (
        <p id={errorId} className="text-destructive mt-1.5 text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
