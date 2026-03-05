'use client';

import { useEffect, useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Users, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Badge } from '@/components/ui/badge';
import {
  Form,
  FormField,
  FormItem,
  FormControl,
  FormDescription,
  FormMessage,
} from '@/components/ui/form';
import { inviteStepSchema, type InviteStepData } from '../_actions/schemas';
import { useWizard } from './expert-application-context';
import { StepHeading, fadeInVariant } from './design-system';

interface StepInviteProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

function isValidEmail(email: string): boolean {
  // Cap length at RFC 5321 max to prevent regex backtracking on long input
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function StepInvite({ headingRef }: Readonly<StepInviteProps>): React.JSX.Element {
  const { inviteData, updateStepData, registerValidation } = useWizard();
  const [inputValue, setInputValue] = useState('');

  const form = useForm<InviteStepData>({
    resolver: zodResolver(inviteStepSchema),
    defaultValues: {
      emails: inviteData.emails ?? [],
    },
    mode: 'onSubmit',
  });

  const emails = form.watch('emails') ?? [];

  // Sync form to context
  useEffect(() => {
    const subscription = form.watch((values) => {
      updateStepData('invite', values);
    });
    return () => subscription.unsubscribe();
  }, [form, updateStepData]);

  // Register validation (optional step, always passes)
  const validate = useCallback(async (): Promise<boolean> => {
    return form.trigger();
  }, [form]);

  useEffect(() => {
    registerValidation(validate);
  }, [registerValidation, validate]);

  const addEmails = (raw: string): void => {
    const candidates = raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    const currentEmails = form.getValues('emails') ?? [];
    const existingSet = new Set(currentEmails);
    const newValidEmails = candidates.filter((e) => isValidEmail(e) && !existingSet.has(e));

    if (newValidEmails.length > 0) {
      form.setValue('emails', [...currentEmails, ...newValidEmails], {
        shouldDirty: true,
      });
    }
    setInputValue('');
  };

  const removeEmail = (email: string): void => {
    const current = form.getValues('emails') ?? [];
    form.setValue(
      'emails',
      current.filter((e) => e !== email),
      { shouldDirty: true }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addEmails(inputValue);
    }
  };

  const handleBlur = (): void => {
    if (inputValue.trim()) {
      addEmails(inputValue);
    }
  };

  return (
    <Form {...form}>
      <form className="mx-auto max-w-lg space-y-6 pt-4">
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <StepHeading
            icon={Users}
            iconColor="text-violet-600"
            iconBg="bg-violet-100 dark:bg-violet-950/30"
            iconBorder="border-violet-200 dark:border-violet-800"
            title="Know other Salesforce experts?"
            subtitle="Invite colleagues to join Balo. Totally optional -- you can always do this from your dashboard later."
          />
        </div>

        {/* Main content with fadeIn */}
        <motion.div
          initial={fadeInVariant.initial}
          animate={fadeInVariant.animate}
          transition={fadeInVariant.transition}
          className="space-y-6"
        >
          {/* Icon */}
          <div className="flex justify-center">
            <div className="rounded-2xl bg-violet-100 p-4 dark:bg-violet-950/30">
              <Users className="h-12 w-12 text-violet-600" aria-hidden="true" />
            </div>
          </div>

          {/* Email chips */}
          <AnimatePresence>
            {emails.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="flex flex-wrap gap-2"
              >
                {emails.map((email) => (
                  <motion.div
                    key={email}
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Badge variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
                      {email}
                      <button
                        type="button"
                        onClick={() => removeEmail(email)}
                        className="hover:text-foreground"
                        aria-label={`Remove ${email}`}
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </Badge>
                  </motion.div>
                ))}
                <p className="text-muted-foreground mt-1 w-full text-xs">
                  {emails.length} invitation{emails.length === 1 ? '' : 's'} ready to send
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Email textarea */}
          <FormField
            control={form.control}
            name="emails"
            render={() => (
              <FormItem>
                <FormControl>
                  <textarea
                    className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[120px] w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                    placeholder="sarah@example.com, james@acme.com"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleBlur}
                  />
                </FormControl>
                <FormDescription>
                  Enter email addresses separated by commas or new lines. We&apos;ll send each
                  person a friendly invitation.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <p className="text-muted-foreground text-xs">
            We&apos;ll only send one invitation email per address. Your colleagues can apply
            whenever they&apos;re ready.
          </p>

          <p className="text-muted-foreground mt-4 text-center text-sm font-medium">
            You&apos;re almost done &mdash; just one more step!
          </p>
        </motion.div>
      </form>
    </Form>
  );
}
