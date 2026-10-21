'use client';

import { useEffect, useRef } from 'react';
import { Check, Eye } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { personAtCompany } from './proposal-format';

interface ProposalSentProps {
  requestId: string;
  /** The client company the proposal went to. */
  companyName: string;
  /** The company's real name, or null when the request has none — person attribution only. */
  clientCompanyName: string | null;
  /** The person at that company who reviews it. */
  clientName: string;
  /** Revise mode: the headline names the version instead of congratulating. */
  reviseMode: boolean;
  /** The version that was just written. */
  version: number;
}

/**
 * The confirmation after a successful send (BAL-610), rendered by the page while the URL
 * carries `?sent=<version>`. "View proposal" drops that param so the page renders the
 * submitted view; "Back to project" leaves.
 */
export function ProposalSent({
  requestId,
  companyName,
  clientCompanyName,
  clientName,
  reviseMode,
  version,
}: Readonly<ProposalSentProps>): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="mx-auto mt-14 max-w-xl text-center">
      <motion.div
        initial={reduceMotion ? false : { scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="from-primary mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full bg-gradient-to-r to-violet-600 text-white dark:to-violet-500"
      >
        <Check className="h-8 w-8" aria-hidden="true" />
      </motion.div>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-foreground mb-2.5 text-[26px] font-semibold tracking-tight outline-none"
      >
        {reviseMode
          ? `Version ${version} is with ${companyName}`
          : `Nice work. Your proposal is with ${companyName}`}
      </h1>
      <p className="text-muted-foreground mb-6">
        {personAtCompany(clientName, clientCompanyName)} has an email and a notification in Balo. If
        they&apos;d like changes, their notes will appear right beside the section they&apos;re
        about, so you can update it and resend.
      </p>
      <div className="flex flex-wrap justify-center gap-2.5">
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => router.replace(pathname)}
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
          View proposal
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => router.push(`/projects/${requestId}`)}
        >
          Back to project
        </Button>
      </div>
    </div>
  );
}
